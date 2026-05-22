import { customAlphabet } from 'nanoid';
import type { LabTemplate, LabInstance } from '@prisma/client';
import { LabTemplateSpec } from '@labforge/shared';
import { prisma } from './db.js';
import { config } from './config.js';
import { getRuntime } from './runtime/index.js';

// Lowercase, DNS-safe — used as subdomain.
const sub = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

export interface AcquireInput {
  tenantId: string;
  template: LabTemplate;
  userIdHash: string;
  durationMinutes: number;
}

/**
 * Acquire an instance for a user. Strategy:
 *   1. If a pre-warmed instance for this template exists, claim it atomically.
 *   2. Otherwise provision a fresh one.
 *
 * Returns once the runtime has started (not necessarily ready — caller polls).
 */
export async function acquireInstance(input: AcquireInput): Promise<LabInstance> {
  const expiresAt = new Date(Date.now() + input.durationMinutes * 60_000);

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

  const instance = await prisma.labInstance.create({
    data: {
      tenantId: input.tenantId,
      templateId: input.template.id,
      status: 'provisioning',
      isPrewarm: input.isPrewarm,
      subdomain,
      userIdHash: input.userIdHash,
      expiresAt: input.expiresAt,
    },
  });

  try {
    const runtime = getRuntime();
    const { runtimeId, upstream } = await runtime.provision({
      instanceId: instance.id,
      subdomain,
      spec,
      userIdHash: input.userIdHash,
      labels: {
        tenant: input.tenantId,
        template: input.template.id,
      },
    });

    return prisma.labInstance.update({
      where: { id: instance.id },
      data: { runtimeId, upstream, status: 'ready' },
    });
  } catch (err) {
    await prisma.labInstance.update({
      where: { id: instance.id },
      data: { status: 'failed' },
    });
    throw err;
  }
}

export async function destroyInstance(instanceId: string): Promise<void> {
  const inst = await prisma.labInstance.findUnique({ where: { id: instanceId } });
  if (!inst) return;
  if (inst.runtimeId) {
    try {
      await getRuntime().destroy(inst.runtimeId);
    } catch {
      // best-effort; status update below records intent
    }
  }
  await prisma.labInstance.update({
    where: { id: instanceId },
    data: { status: 'terminated', terminatedAt: new Date() },
  });
}

/** Public URL the gateway will route to this instance. */
export function instanceUrl(subdomain: string): string {
  const base = new URL(config.PUBLIC_GATEWAY_URL);
  base.hostname = `${subdomain}.${config.PUBLIC_LAB_DOMAIN}`;
  return base.toString().replace(/\/$/, '');
}
