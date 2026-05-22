import type { UsageEventKind } from '@prisma/client';
import { prisma } from './db.js';

/**
 * Billing-grade event emitter. Writes a row to `UsageEvent` for every
 * interesting lab lifecycle moment so we can derive pax-days, compute
 * hours, and resolve disputes without scraping live tables.
 *
 * Best-effort: never throws, never blocks the caller's path. If the DB is
 * down or the write fails, we drop the event (the alternative — failing
 * the launch — is worse than a missing audit row).
 */
export interface RecordUsageInput {
  tenantId: string;
  kind: UsageEventKind;
  launchId?: string | null;
  instanceId?: string | null;
  templateId?: string | null;
  userIdHash?: string | null;
  /** Free-form bag; goes in the JSON `payload` column. */
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: {
        tenantId: input.tenantId,
        kind: input.kind,
        launchId: input.launchId ?? null,
        instanceId: input.instanceId ?? null,
        templateId: input.templateId ?? null,
        userIdHash: input.userIdHash ?? null,
        payload: (input.payload ?? null) as never,
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  } catch {
    // swallow — metering must never break the user-visible path
  }
}

/** Fire-and-forget convenience for hot paths that don't want to await. */
export function emitUsage(input: RecordUsageInput): void {
  void recordUsage(input);
}
