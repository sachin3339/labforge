import { customAlphabet } from 'nanoid';
import { createHash } from 'node:crypto';
import type { LabTemplate, LabInstance, Node } from '@prisma/client';
import { LabTemplateSpec, type LabTemplateSpec as LabTemplateSpecT } from '@labforge/shared';
import { prisma } from './db.js';
import { config } from './config.js';
import { getRuntime } from './runtime/index.js';
import { getNodeRuntime, resolveNodeForProvision } from './runtime/nodes.js';
import {
  qemuImgCreateOverlay,
  rmOverlayDir,
  waitForRdpReady,
} from './runtime/nodeShell.js';
import {
  clearGuacamoleCredentials,
  ensureGuacamoleCredentials,
  regenerateUserMapping,
} from './runtime/guacamole.js';
import type {
  HostBindMount,
  LabRuntime,
  VolumeMount,
} from './runtime/types.js';
import { emitUsage } from './metering.js';

/**
 * Look up the runtime that owns this instance — every lifecycle op
 * (suspend/resume/destroy/restart/logs/exec) must hit the same Docker host
 * the container actually lives on. Falls back to the local-socket runtime
 * when an instance pre-dates the multi-node migration (instance.nodeId =
 * null), which is safe because all such rows were provisioned on the host
 * the control-plane currently runs on.
 */
export async function runtimeFor(inst: { nodeId: string | null }): Promise<LabRuntime> {
  if (!inst.nodeId) return getRuntime();
  const node = await prisma.node.findUnique({ where: { id: inst.nodeId } });
  return getNodeRuntime(node);
}

/**
 * After resume()/restart() the Docker daemon may have reassigned the
 * ephemeral host port (ports are NOT preserved across `docker start` on
 * some daemons / host reboots). Re-inspect, and if the binding drifted
 * from what we stored at provision-time, persist the new value so the
 * wildcard proxy keeps routing correctly. Best-effort: failures are
 * logged-then-swallowed (the next health probe / redeem will resync).
 */
async function syncInstanceUpstream(
  inst: {
    id: string;
    runtimeId: string | null;
    hostPort: number | null;
    upstream: string | null;
    rdpHostPort: number | null;
  },
  runtime: LabRuntime,
  rdpContainerPort?: number,
): Promise<{
  hostPort: number | null;
  upstream: string | null;
  rdpHostPort: number | null;
  rdpDrifted: boolean;
}> {
  if (!inst.runtimeId)
    return {
      hostPort: inst.hostPort,
      upstream: inst.upstream,
      rdpHostPort: inst.rdpHostPort,
      rdpDrifted: false,
    };
  try {
    const info = await runtime.inspectInstance(inst.runtimeId);
    if (!info) {
      return {
        hostPort: inst.hostPort,
        upstream: inst.upstream,
        rdpHostPort: inst.rdpHostPort,
        rdpDrifted: false,
      };
    }
    // Re-detect the RDP host port for guacamole-rdp instances. The host
    // port is ephemeral and can move on `docker start`, so the
    // user-mapping.xml has to be re-rendered when it does.
    let nextRdp: number | null = inst.rdpHostPort;
    let rdpDrifted = false;
    if (rdpContainerPort && info.allHostPorts) {
      const key = `${rdpContainerPort}/tcp`;
      const found = info.allHostPorts[key];
      if (found && found !== inst.rdpHostPort) {
        nextRdp = found;
        rdpDrifted = true;
      }
    }
    const httpDrifted =
      info.hostPort != null &&
      info.upstream != null &&
      (info.hostPort !== inst.hostPort || info.upstream !== inst.upstream);
    if (!httpDrifted && !rdpDrifted) {
      return {
        hostPort: inst.hostPort,
        upstream: inst.upstream,
        rdpHostPort: inst.rdpHostPort,
        rdpDrifted: false,
      };
    }
    const data: {
      hostPort?: number | null;
      upstream?: string | null;
      rdpHostPort?: number | null;
    } = {};
    if (httpDrifted) {
      data.hostPort = info.hostPort ?? null;
      data.upstream = info.upstream ?? null;
    }
    if (rdpDrifted) data.rdpHostPort = nextRdp;
    await prisma.labInstance.update({ where: { id: inst.id }, data });
    return {
      hostPort: httpDrifted ? info.hostPort ?? null : inst.hostPort,
      upstream: httpDrifted ? info.upstream ?? null : inst.upstream,
      rdpHostPort: nextRdp,
      rdpDrifted,
    };
  } catch {
    return {
      hostPort: inst.hostPort,
      upstream: inst.upstream,
      rdpHostPort: inst.rdpHostPort,
      rdpDrifted: false,
    };
  }
}

// Lowercase, DNS-safe — used as subdomain.
const sub = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

/** Statuses where the existing container is still usable (running or stopped-but-keepable). */
const REUSABLE_STATUSES = new Set<LabInstance['status']>([
  'pending',
  'provisioning',
  'ready',
  'idle',
  'paused',
]);

export interface AcquireInput {
  tenantId: string;
  template: LabTemplate;
  userIdHash: string;
  durationMinutes: number;
  /** Explicit expiry. Overrides durationMinutes. Use for batch-tied lifetime. */
  expiresAt?: Date;
}

/**
 * Acquire an instance for a user. Strategy:
 *   1. If THIS user already has a live/suspended instance for this template,
 *      reuse it (data is on the volume, container may need resume).
 *   2. Else if a pre-warmed instance for this template exists, claim it.
 *   3. Else provision a fresh one.
 *
 * Caller is responsible for resuming a stopped container if needed (the
 * redeem route does this).
 */
export async function acquireInstance(input: AcquireInput): Promise<LabInstance> {
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + input.durationMinutes * 60_000);

  // 0. Per-user reuse: do we already have one for this (template, user)?
  const existing = await prisma.labInstance.findFirst({
    where: {
      templateId: input.template.id,
      userIdHash: input.userIdHash,
      isPrewarm: false,
      status: { in: Array.from(REUSABLE_STATUSES) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    // Extend expiry if the new acquire window is longer.
    if (existing.expiresAt < expiresAt) {
      return prisma.labInstance.update({
        where: { id: existing.id },
        data: { expiresAt },
      });
    }
    return existing;
  }

  // 1. Try claiming a prewarm.
  const claimed = await claimPrewarm(input.template.id, input.userIdHash, expiresAt);
  if (claimed) return claimed;

  // 2. Provision fresh.
  return provisionNew({
    tenantId: input.tenantId,
    template: input.template,
    userIdHash: input.userIdHash,
    expiresAt,
    isPrewarm: false,
  });
}

async function claimPrewarm(
  templateId: string,
  userIdHash: string,
  expiresAt: Date,
): Promise<LabInstance | null> {
  // Atomic claim: UPDATE ... WHERE isPrewarm=true AND status='ready' LIMIT 1.
  // Prisma doesn't expose UPDATE-LIMIT-RETURNING directly, so we use a raw CTE.
  const rows = await prisma.$queryRaw<LabInstance[]>`
    UPDATE "LabInstance"
       SET "isPrewarm" = false,
           "userIdHash" = ${userIdHash},
           "expiresAt" = ${expiresAt}
     WHERE "id" IN (
       SELECT "id" FROM "LabInstance"
        WHERE "templateId" = ${templateId}
          AND "isPrewarm" = true
          AND "status" = 'ready'
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *;
  `;
  const claimed = rows[0] ?? null;
  if (claimed) {
    emitUsage({
      tenantId: claimed.tenantId,
      kind: 'instance_ready',
      instanceId: claimed.id,
      templateId: claimed.templateId,
      userIdHash: claimed.userIdHash,
      payload: { source: 'prewarm' },
    });
  }
  return claimed;
}

export interface ProvisionNewInput {
  tenantId: string;
  template: LabTemplate;
  userIdHash?: string;
  expiresAt: Date;
  isPrewarm: boolean;
}

/**
 * Resolve the abstract `spec.viewer` field (which defaults to 'auto')
 * to the concrete viewer the redeem flow will hand the student. We
 * compute this in one place so orchestrator + redeem agree.
 *
 *   - vm + rdpUsername set → 'guacamole-rdp'  (preferred path for Win labs)
 *   - vm without RDP creds → 'novnc'          (legacy in-container :8006)
 *   - everything else      → 'native-http'    (subdomain proxy on spec.port)
 *
 * An explicit non-'auto' value always wins.
 */
export type ResolvedViewer = 'native-http' | 'novnc' | 'guacamole-rdp';

export function resolveViewer(spec: LabTemplateSpecT): ResolvedViewer {
  if (spec.viewer && spec.viewer !== 'auto') return spec.viewer;
  if (spec.runtime === 'vm') {
    return spec.rdpUsername && spec.rdpUsername.length > 0
      ? 'guacamole-rdp'
      : 'novnc';
  }
  return 'native-http';
}

/**
 * Best-effort spec parse. Returns null on validation failure so callers
 * (resume/restart paths) can degrade gracefully — a malformed spec
 * shouldn't block resume.
 */
function safeParseSpec(raw: unknown): LabTemplateSpecT | null {
  const r = LabTemplateSpec.safeParse(raw);
  return r.success ? r.data : null;
}

export async function provisionNew(input: ProvisionNewInput): Promise<LabInstance> {
  const spec = LabTemplateSpec.parse(input.template.spec);
  const subdomain = sub();

  // Linked-clone branch: when the template carries a golden-image path
  // we use a per-instance qcow2 overlay (shared backing file) instead
  // of named volumes. There is no cross-instance persistence — every
  // clone gets a fresh disk seeded from the golden, and the overlay
  // directory is removed on destroy.
  const isLinkedClone = !!spec.vmGoldenImage;
  const resolvedViewer = resolveViewer(spec);

  // Volumes are PER USER + PER TEMPLATE so a student gets the same data
  // back regardless of how many times their container is replaced. Prewarm
  // pool instances get no volume — they're stateless until claimed.
  // Linked-clone instances also skip volumes (overlays are throwaway).
  const volumes: VolumeMount[] = [];
  let volumeName: string | null = null;
  if (!input.isPrewarm && input.userIdHash && !isLinkedClone) {
    volumeName = computeVolumeName(input.userIdHash, input.template.id);
    for (const path of effectivePersistPaths(spec)) {
      volumes.push({ name: volumeName, containerPath: path });
    }
  }

  // Resolve the target node FIRST and persist nodeId on the row before
  // the slow runtime.provision() call. This makes the in-flight row visible
  // to the load-spread scheduler immediately — without it, concurrent
  // provisions (e.g. /batches/:id/prepare with concurrency=5) all see the
  // same "0 load" snapshot and pile onto the same node.
  //
  // Sticky node: if this user already has a persistent volume on a
  // specific node (from a prior instance — terminated, failed, paused,
  // anything), pin the new container to that same node. Docker volumes
  // are local to a host, so scheduling the replacement onto a different
  // node would silently create an empty volume with the same name there
  // and the student's work would appear lost. We never want that.
  //
  // We probe each enabled node's docker daemon for the volume directly
  // rather than trusting the most-recent LabInstance.nodeId — that DB
  // hint can be wrong when a previous provision incorrectly landed on
  // a node where the volume was auto-created empty (e.g. before this
  // sticky-node logic existed). The on-disk volume is the source of
  // truth for "where does this student's data live".
  let node = null as Awaited<ReturnType<typeof resolveNodeForProvision>>;
  if (!input.isPrewarm && input.userIdHash && volumeName) {
    const candidates = await prisma.node.findMany({
      where: { enabled: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const probed: { node: Node; hasVolume: boolean }[] = [];
    for (const c of candidates) {
      try {
        const rt = await getNodeRuntime(c);
        const has = await rt.volumeExists(volumeName);
        probed.push({ node: c, hasVolume: has });
      } catch {
        // Node unreachable: treat as unknown (don't pin to it, but also
        // don't pin elsewhere if another reachable node has the volume).
        probed.push({ node: c, hasVolume: false });
      }
    }
    const holders = probed.filter((p) => p.hasVolume).map((p) => p.node);
    if (holders.length === 1) {
      node = holders[0];
    } else if (holders.length > 1) {
      // Multi-host volume collision (shouldn't normally happen). Prefer
      // the most-recent prior instance's node if it's a holder; else the
      // first holder by deterministic order.
      const prior = await prisma.labInstance.findFirst({
        where: {
          templateId: input.template.id,
          userIdHash: input.userIdHash,
          volumeName,
          nodeId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { nodeId: true },
      });
      node = holders.find((h) => h.id === prior?.nodeId) ?? holders[0];
    }

    // If the holder is outside the template's allowed-nodes pool, pin
    // there anyway (data integrity beats scheduling policy) but warn so
    // an operator can decide to migrate the volume later.
    const allowed: string[] = (input.template as { allowedNodeIds?: string[] }).allowedNodeIds ?? [];
    if (node && allowed.length > 0 && !allowed.includes(node.id)) {
      console.warn(
        `[orchestrator] volume ${volumeName} held by node '${node.name}' which is not in template ` +
          `${input.template.id}.allowedNodeIds=[${allowed.join(',')}]; pinning to holder anyway`,
      );
    }
  }
  if (!node) {
    node = await resolveNodeForProvision(input.tenantId, input.template.id);
  }

  // For linked-clone instances we record the on-node overlay path on
  // the row right after qemu-img create (below) so a crash mid-provision
  // still leaves a row pointing at a recoverable / cleanable directory.
  const instance = await prisma.labInstance.create({
    data: {
      tenantId: input.tenantId,
      templateId: input.template.id,
      status: 'provisioning',
      isPrewarm: input.isPrewarm,
      subdomain,
      userIdHash: input.userIdHash,
      expiresAt: input.expiresAt,
      volumeName,
      nodeId: node?.id ?? null,
      vmOverlayPath: null, // set after qemu-img create succeeds
    },
  });

  try {
    // Linked-clone preparation: create the per-instance qcow2 overlay
    // on the worker node before docker createContainer. We do this
    // here (not inside the docker runtime) because it requires shell
    // access to the host filesystem, which is outside the runtime
    // contract on purpose.
    let bindMounts: HostBindMount[] | undefined;
    let resolvedOverlayDir: string | null = null;
    if (isLinkedClone && spec.vmGoldenImage) {
      resolvedOverlayDir = `${spec.vmStorageHostBase.replace(/\/+$/, '')}/${instance.id}`;
      await qemuImgCreateOverlay(node, {
        overlayDir: resolvedOverlayDir,
        goldenImagePath: spec.vmGoldenImage,
        overlaySize: spec.vmOverlaySize,
      });
      // Two bind mounts:
      //   1. The overlay dir at /storage — dockur reads /storage/data.img.
      //   2. The golden image at its OWN absolute host path read-only —
      //      qcow2 stores the absolute backing-file path inside the
      //      overlay header, and qemu resolves that path INSIDE the
      //      container at run time. Without this second mount, qemu
      //      opens /opt/labforge/win-golden/golden.img on a path that
      //      doesn't exist inside the container and fails with
      //      "Could not open backing file".
      bindMounts = [
        { hostPath: resolvedOverlayDir, containerPath: '/storage' },
        {
          hostPath: spec.vmGoldenImage,
          containerPath: spec.vmGoldenImage,
          readOnly: true,
        },
      ];
      await prisma.labInstance.update({
        where: { id: instance.id },
        data: { vmOverlayPath: resolvedOverlayDir },
      });
    }

    // Node was already resolved above and persisted on the instance row so
    // concurrent pickLeastLoadedNode() calls see this in-flight provision.
    // A null node means no nodes are configured yet; fall back to the
    // legacy local-socket runtime so the very-first-boot dev story still
    // works before the operator opens the Nodes UI.
    const runtime = node ? await getNodeRuntime(node) : getRuntime();
    // Extra port to publish for Guacamole-RDP path: the dockur container's
    // RDP port. We let Docker pick the host port and capture it from the
    // result so Guacamole can dial it.
    const extraPortBindings =
      resolvedViewer === 'guacamole-rdp' ? [spec.rdpContainerPort] : undefined;

    const { runtimeId, upstream, hostPort, extraHostPorts } =
      await runtime.provision({
        instanceId: instance.id,
        subdomain,
        spec,
        userIdHash: input.userIdHash,
        volumes,
        bindMounts,
        extraPortBindings,
        labels: {
          tenant: input.tenantId,
          template: input.template.id,
        },
      });

    const rdpHostPort =
      resolvedViewer === 'guacamole-rdp'
        ? extraHostPorts?.[spec.rdpContainerPort] ?? null
        : null;

    // Block on real RDP readiness (X.224 negotiation reply) before the
    // row goes to 'ready'. Without this, the dockur container has its
    // 3389 host port published the moment QEMU starts (BIOS phase, no
    // OS yet) so a TCP connect succeeds but Guacamole gets "Server
    // refused connection (wrong security type?)" because no RDP server
    // is listening yet — Windows is still booting. We saw this happen
    // 100% of the time with cold-start launches in the smoke test.
    //
    // Probe runs on the worker node so we hit 127.0.0.1:<rdpHostPort>
    // and avoid traversing the public internet on every poll. Generous
    // 4-minute timeout because cold Windows boot from golden can take
    // 60-180s under contention.
    if (resolvedViewer === 'guacamole-rdp' && rdpHostPort) {
      await waitForRdpReady(node, '127.0.0.1', rdpHostPort, 240_000);
    }

    const updated = await prisma.labInstance.update({
      where: { id: instance.id },
      data: {
        runtimeId,
        upstream,
        hostPort: hostPort ?? null,
        rdpHostPort,
        nodeId: node?.id ?? null,
        status: 'ready',
        lastActivityAt: new Date(),
      },
    });
    // Guacamole side-effect: mint per-instance creds and re-render the
    // user-mapping.xml so the redeem flow can hand the student a
    // ready-to-use auto-login URL. Best-effort — failures are logged
    // but don't fail the provision (operator can re-run the regen
    // manually or via a future "Resync Guacamole" admin button).
    if (!input.isPrewarm && resolvedViewer === 'guacamole-rdp' && rdpHostPort) {
      try {
        await ensureGuacamoleCredentials(prisma, updated.id);
        await regenerateUserMapping(prisma);
      } catch (err) {
        console.warn(
          `[orchestrator] guacamole sync failed for ${updated.id}: ` +
            (err as Error).message,
        );
      }
    }
    if (!input.isPrewarm) {
      emitUsage({
        tenantId: updated.tenantId,
        kind: 'instance_ready',
        instanceId: updated.id,
        templateId: updated.templateId,
        userIdHash: updated.userIdHash,
      });
    }
    return updated;
  } catch (err) {
    await prisma.labInstance.update({
      where: { id: instance.id },
      data: { status: 'failed' },
    });
    throw err;
  }
}

/**
 * Per-user, per-template Docker volume name. Stable across container
 * lifecycles so the same student gets the same data back every time.
 *
 *   lf-data-<userHash8>-<templateHash8>
 *
 * Docker volume names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; we keep ours strictly
 * lowercase alnum + hyphen to be safe on every backend.
 */
function computeVolumeName(userIdHash: string, templateId: string): string {
  const u = userIdHash.slice(0, 16).toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = createHash('sha1').update(templateId).digest('hex').slice(0, 8);
  return `lf-data-${u}-${t}`;
}

/**
 * Paths inside the container that should be persisted. Templates can
 * declare them explicitly via `spec.persistPaths`; if they don't, fall
 * back to `spec.workspaceDir` so naive templates still get persistence.
 */
function effectivePersistPaths(spec: LabTemplateSpecT): string[] {
  if (spec.persistPaths && spec.persistPaths.length > 0) return spec.persistPaths;
  if (spec.workspaceDir) return [spec.workspaceDir];
  return [];
}

export interface DestroyOptions {
  /** When true, also delete the per-user named volume (irreversibly removes student data). */
  deleteVolume?: boolean;
}

export async function destroyInstance(
  instanceId: string,
  opts: DestroyOptions = {},
): Promise<void> {
  const inst = await prisma.labInstance.findUnique({ where: { id: instanceId } });
  if (!inst) return;
  const runtime = await runtimeFor(inst);
  if (inst.runtimeId) {
    try {
      await runtime.destroy(inst.runtimeId);
    } catch {
      // best-effort; status update below records intent
    }
  }
  if (opts.deleteVolume && inst.volumeName) {
    try {
      await runtime.destroyVolume(inst.volumeName);
    } catch {
      // best-effort
    }
  }
  // Linked-clone overlays are always cleaned up on destroy regardless
  // of `deleteVolume` — overlays are throwaway by design (the golden
  // image is the source of truth, the overlay was a per-instance
  // qcow2 born/died with this row).
  if (inst.vmOverlayPath && inst.nodeId) {
    try {
      const node = await prisma.node.findUnique({ where: { id: inst.nodeId } });
      await rmOverlayDir(node, inst.vmOverlayPath);
    } catch (err) {
      console.warn(
        `[orchestrator] overlay cleanup failed for ${instanceId} at ` +
          `${inst.vmOverlayPath}: ${(err as Error).message}`,
      );
    }
  }
  // Drop the Guacamole entry so a destroyed lab no longer answers
  // its old client URL. Best-effort — at worst the entry sticks
  // around until the next regenerate.
  if (inst.guacamoleUser) {
    try {
      await clearGuacamoleCredentials(prisma, inst.id);
      await regenerateUserMapping(prisma);
    } catch (err) {
      console.warn(
        `[orchestrator] guacamole cleanup failed for ${instanceId}: ` +
          (err as Error).message,
      );
    }
  }
  await prisma.labInstance.update({
    where: { id: instanceId },
    data: { status: 'terminated', terminatedAt: new Date() },
  });
  emitUsage({
    tenantId: inst.tenantId,
    kind: 'instance_terminated',
    instanceId: inst.id,
    templateId: inst.templateId,
    userIdHash: inst.userIdHash,
    payload: { deleteVolume: opts.deleteVolume === true, prevStatus: inst.status },
  });
}

/**
 * Suspend a running lab: stop the container gracefully, preserve volumes,
 * mark the row `paused`. Idempotent \u2014 a no-op on already-paused/terminated.
 */
export async function suspendInstance(instanceId: string): Promise<void> {
  const inst = await prisma.labInstance.findUnique({ where: { id: instanceId } });
  if (!inst || !inst.runtimeId) return;
  if (inst.status === 'paused' || inst.status === 'terminated' || inst.status === 'failed') {
    return;
  }
  const runtime = await runtimeFor(inst);
  await runtime.suspend(inst.runtimeId);
  await prisma.labInstance.update({
    where: { id: instanceId },
    data: { status: 'paused', suspendedAt: new Date() },
  });
  emitUsage({
    tenantId: inst.tenantId,
    kind: 'instance_paused',
    instanceId: inst.id,
    templateId: inst.templateId,
    userIdHash: inst.userIdHash,
  });
}

/**
 * Resume a suspended lab: start the container and (optionally) wait for the
 * upstream to be reachable. Returns the updated row.
 */
export async function resumeInstance(
  instanceId: string,
  opts: { waitMs?: number } = {},
): Promise<LabInstance> {
  const inst = await prisma.labInstance.findUniqueOrThrow({ where: { id: instanceId } });
  if (!inst.runtimeId) {
    throw new Error(`instance ${instanceId} has no runtimeId; cannot resume`);
  }
  const runtime = await runtimeFor(inst);
  await runtime.resume(inst.runtimeId);
  // Detect & persist port drift BEFORE the readiness probe so isReady() is
  // pointed at the right host:port. Without this, a daemon that reassigned
  // the ephemeral port would make every probe fail and the redeem would
  // hand the student a stale URL.
  const tmpl = await prisma.labTemplate.findUnique({ where: { id: inst.templateId } });
  const parsedSpec = tmpl ? safeParseSpec(tmpl.spec) : null;
  const rdpContainerPort =
    parsedSpec && resolveViewer(parsedSpec) === 'guacamole-rdp'
      ? parsedSpec.rdpContainerPort
      : undefined;
  const synced = await syncInstanceUpstream(inst, runtime, rdpContainerPort);
  const updated = await prisma.labInstance.update({
    where: { id: instanceId },
    data: {
      status: 'ready',
      suspendedAt: null,
      lastActivityAt: new Date(),
      hostPort: synced.hostPort,
      upstream: synced.upstream,
    },
  });
  // RDP host port can drift on `docker start`. When it does we need to
  // re-render the Guacamole user-mapping so the auto-login URL routes to
  // the new ephemeral port. Best-effort.
  if (synced.rdpDrifted && updated.guacamoleUser) {
    try {
      await regenerateUserMapping(prisma);
    } catch (err) {
      console.warn(
        `[orchestrator] guacamole rdp-drift sync failed for ${updated.id}: ` +
          (err as Error).message,
      );
    }
  }
  emitUsage({
    tenantId: updated.tenantId,
    kind: 'instance_resumed',
    instanceId: updated.id,
    templateId: updated.templateId,
    userIdHash: updated.userIdHash,
  });

  // Optional inline wait so callers (e.g. redeem) can hand the student a
  // working URL the instant the container is healthy.
  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0 && updated.upstream) {
    const scheme: 'http' | 'https' =
      parsedSpec?.upstreamScheme === 'https' ? 'https' : 'http';
    await waitUntilReady(inst.runtimeId, updated.upstream, waitMs, scheme, runtime);
  }
  return updated;
}

export async function waitUntilReady(
  runtimeId: string,
  upstream: string,
  timeoutMs: number,
  scheme: 'http' | 'https' = 'http',
  runtime: LabRuntime = getRuntime(),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await runtime.isReady(runtimeId, upstream, scheme)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Restart an instance in place (docker restart). Preserves the runtimeId
 * and the mounted volumes, so the student's data and the subdomain stay
 * the same. Useful for unfreezing a wedged container.
 */
export async function restartInstance(instanceId: string): Promise<void> {
  const inst = await prisma.labInstance.findUnique({ where: { id: instanceId } });
  if (!inst || !inst.runtimeId) return;
  const runtime = await runtimeFor(inst);
  await runtime.restart(inst.runtimeId);
  // Same rationale as resumeInstance(): docker restart can reassign the
  // host port; persist any drift before clients try to use the URL.
  const tmpl = await prisma.labTemplate.findUnique({ where: { id: inst.templateId } });
  const parsedSpec = tmpl ? safeParseSpec(tmpl.spec) : null;
  const rdpContainerPort =
    parsedSpec && resolveViewer(parsedSpec) === 'guacamole-rdp'
      ? parsedSpec.rdpContainerPort
      : undefined;
  const synced = await syncInstanceUpstream(inst, runtime, rdpContainerPort);
  const updated = await prisma.labInstance.update({
    where: { id: instanceId },
    data: {
      status: 'ready',
      suspendedAt: null,
      lastActivityAt: new Date(),
      hostPort: synced.hostPort,
      upstream: synced.upstream,
    },
  });
  if (synced.rdpDrifted && updated.guacamoleUser) {
    try {
      await regenerateUserMapping(prisma);
    } catch (err) {
      console.warn(
        `[orchestrator] guacamole rdp-drift sync failed for ${updated.id}: ` +
          (err as Error).message,
      );
    }
  }
}

/**
 * Extend an instance's expiry. The reaper enforces `expiresAt` on every
 * tick, so this is the single source of truth for "keep this lab alive
 * longer". Caller is responsible for any ACL check.
 */
export async function extendInstance(
  instanceId: string,
  newExpiresAt: Date,
): Promise<LabInstance> {
  return prisma.labInstance.update({
    where: { id: instanceId },
    data: { expiresAt: newExpiresAt },
  });
}

/** Tail container logs (best-effort). Returns empty string if gone. */
export async function getInstanceLogs(
  instanceId: string,
  tail = 200,
): Promise<string> {
  const inst = await prisma.labInstance.findUnique({ where: { id: instanceId } });
  if (!inst || !inst.runtimeId) return '';
  const runtime = await runtimeFor(inst);
  return runtime.logs(inst.runtimeId, { tail });
}

/** Public URL the gateway will route to this instance. */
export function instanceUrl(subdomain: string): string {
  const base = new URL(config.PUBLIC_GATEWAY_URL);
  base.hostname = `${subdomain}.${config.PUBLIC_LAB_DOMAIN}`;
  return base.toString().replace(/\/$/, '');
}
