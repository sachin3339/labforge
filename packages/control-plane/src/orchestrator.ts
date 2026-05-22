import { customAlphabet } from 'nanoid';
import { createHash } from 'node:crypto';
import type { LabTemplate, LabInstance } from '@prisma/client';
import { LabTemplateSpec, type LabTemplateSpec as LabTemplateSpecT } from '@labforge/shared';
import { prisma } from './db.js';
import { config } from './config.js';
import { getRuntime } from './runtime/index.js';
import type { VolumeMount } from './runtime/types.js';

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
  return rows[0] ?? null;
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
    },
  });

  try {
    const runtime = getRuntime();
    const { runtimeId, upstream } = await runtime.provision({
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

    return prisma.labInstance.update({
      where: { id: instance.id },
      data: { runtimeId, upstream, status: 'ready', lastActivityAt: new Date() },
    });
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
  const runtime = getRuntime();
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
  await getRuntime().suspend(inst.runtimeId);
  await prisma.labInstance.update({
    where: { id: instanceId },
    data: { status: 'paused', suspendedAt: new Date() },
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
  const runtime = getRuntime();
  await runtime.resume(inst.runtimeId);
  const updated = await prisma.labInstance.update({
    where: { id: instanceId },
    data: { status: 'ready', suspendedAt: null, lastActivityAt: new Date() },
  });

  // Optional inline wait so callers (e.g. redeem) can hand the student a
  // working URL the instant the container is healthy.
  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0 && updated.upstream) {
    await waitUntilReady(inst.runtimeId, updated.upstream, waitMs);
  }
  return updated;
}

export async function waitUntilReady(
  runtimeId: string,
  upstream: string,
  timeoutMs: number,
): Promise<boolean> {
  const runtime = getRuntime();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await runtime.isReady(runtimeId, upstream)) return true;
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
  await getRuntime().restart(inst.runtimeId);
  await prisma.labInstance.update({
    where: { id: instanceId },
    data: {
      status: 'ready',
      suspendedAt: null,
      lastActivityAt: new Date(),
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
  return getRuntime().logs(inst.runtimeId, { tail });
}

/** Public URL the gateway will route to this instance. */
export function instanceUrl(subdomain: string): string {
  const base = new URL(config.PUBLIC_GATEWAY_URL);
  base.hostname = `${subdomain}.${config.PUBLIC_LAB_DOMAIN}`;
  return base.toString().replace(/\/$/, '');
}
