import { customAlphabet } from 'nanoid';
import { createHash } from 'node:crypto';
import type { LabTemplate, LabInstance, Node } from '@prisma/client';
import { LabTemplateSpec, type LabTemplateSpec as LabTemplateSpecT } from '@labforge/shared';
import { prisma } from './db.js';
import { config } from './config.js';
import { getRuntime } from './runtime/index.js';
import { getNodeRuntime, resolveNodeForProvision } from './runtime/nodes.js';
import type { LabRuntime, VolumeMount } from './runtime/types.js';
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
  inst: { id: string; runtimeId: string | null; hostPort: number | null; upstream: string | null },
  runtime: LabRuntime,
): Promise<{ hostPort: number | null; upstream: string | null }> {
  if (!inst.runtimeId) return { hostPort: inst.hostPort, upstream: inst.upstream };
  try {
    const info = await runtime.inspectInstance(inst.runtimeId);
    if (!info || !info.hostPort || !info.upstream) {
      return { hostPort: inst.hostPort, upstream: inst.upstream };
    }
    if (info.hostPort === inst.hostPort && info.upstream === inst.upstream) {
      return { hostPort: inst.hostPort, upstream: inst.upstream };
    }
    await prisma.labInstance.update({
      where: { id: inst.id },
      data: { hostPort: info.hostPort, upstream: info.upstream },
    });
    return { hostPort: info.hostPort, upstream: info.upstream };
  } catch {
    return { hostPort: inst.hostPort, upstream: inst.upstream };
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

export async function provisionNew(input: ProvisionNewInput): Promise<LabInstance> {
  const spec = LabTemplateSpec.parse(input.template.spec);
  const subdomain = sub();

  // Volumes are PER USER + PER TEMPLATE so a student gets the same data
  // back regardless of how many times their container is replaced. Prewarm
  // pool instances get no volume — they're stateless until claimed.
  const volumes: VolumeMount[] = [];
  let volumeName: string | null = null;
  if (!input.isPrewarm && input.userIdHash) {
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
  }
  if (!node) {
    node = await resolveNodeForProvision(input.tenantId, input.template.id);
  }

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
    },
  });

  try {
    // Node was already resolved above and persisted on the instance row so
    // concurrent pickLeastLoadedNode() calls see this in-flight provision.
    // A null node means no nodes are configured yet; fall back to the
    // legacy local-socket runtime so the very-first-boot dev story still
    // works before the operator opens the Nodes UI.
    const runtime = node ? await getNodeRuntime(node) : getRuntime();
    const { runtimeId, upstream, hostPort } = await runtime.provision({
      instanceId: instance.id,
      subdomain,
      spec,
      userIdHash: input.userIdHash,
      volumes,
      labels: {
        tenant: input.tenantId,
        template: input.template.id,
      },
    });

    const updated = await prisma.labInstance.update({
      where: { id: instance.id },
      data: {
        runtimeId,
        upstream,
        hostPort: hostPort ?? null,
        nodeId: node?.id ?? null,
        status: 'ready',
        lastActivityAt: new Date(),
      },
    });
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
  const synced = await syncInstanceUpstream(inst, runtime);
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
    const tmpl = await prisma.labTemplate.findUnique({
      where: { id: updated.templateId },
    });
    const spec = (tmpl?.spec ?? {}) as { upstreamScheme?: 'http' | 'https' };
    const scheme: 'http' | 'https' = spec.upstreamScheme === 'https' ? 'https' : 'http';
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
  const synced = await syncInstanceUpstream(inst, runtime);
  await prisma.labInstance.update({
    where: { id: instanceId },
    data: {
      status: 'ready',
      suspendedAt: null,
      lastActivityAt: new Date(),
      hostPort: synced.hostPort,
      upstream: synced.upstream,
    },
  });
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
