import { prisma } from './db.js';
import { config } from './config.js';
import { destroyInstance, suspendInstance } from './orchestrator.js';

/**
 * Background reconciler that enforces the three lab lifetime rules:
 *
 *   1. Past `expiresAt` (batch window over)   → terminate + delete volume
 *   2. No student activity for SUSPEND_IDLE   → suspend (docker stop, keep disk)
 *   3. Suspended longer than HARD_INACTIVITY  → hard-terminate + delete volume
 *
 * Runs every REAPER_INTERVAL_SECONDS. Each tick walks at most N rows per
 * rule so a backlog can't starve the loop. Best-effort: errors on one row
 * never stop the rest.
 */

interface Logger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

let timer: NodeJS.Timeout | null = null;
const BATCH = 50;

export function startReaperLoop(logger: Logger): void {
  if (!config.REAPER_ENABLED) {
    logger.info('[reaper] disabled');
    return;
  }
  const tick = async () => {
    try {
      await reconcileOnce(logger);
    } catch (err) {
      logger.error(`[reaper] tick failed: ${(err as Error).message}`);
    }
  };
  void tick();
  timer = setInterval(tick, config.REAPER_INTERVAL_SECONDS * 1000);
  logger.info(`[reaper] loop started (every ${config.REAPER_INTERVAL_SECONDS}s)`);
}

export function stopReaperLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function reconcileOnce(logger: Logger): Promise<void> {
  const now = new Date();
  const suspendBefore = new Date(
    now.getTime() - config.LAB_SUSPEND_IDLE_MINUTES * 60_000,
  );
  const hardKillBefore = new Date(
    now.getTime() - config.LAB_HARD_INACTIVITY_DAYS * 24 * 60 * 60_000,
  );

  // 1. Expired (batch.expiresAt < now) → terminate + drop volume.
  const expired = await prisma.labInstance.findMany({
    where: {
      expiresAt: { lt: now },
      isPrewarm: false,
      status: {
        notIn: ['terminated', 'terminating', 'failed'],
      },
    },
    take: BATCH,
  });
  for (const inst of expired) {
    logger.info(
      `[reaper] expiring instance=${inst.id} sub=${inst.subdomain} ` +
        `expiredAt=${inst.expiresAt.toISOString()}`,
    );
    try {
      await destroyInstance(inst.id, { deleteVolume: true });
    } catch (err) {
      logger.warn(
        `[reaper] failed to expire ${inst.id}: ${(err as Error).message}`,
      );
    }
  }

  // 2. Idle running labs → suspend.
  // `lastActivityAt` is set by the wildcard proxy on every student request;
  // if null we fall back to createdAt so abandoned-since-birth labs still
  // get caught.
  const idle = await prisma.labInstance.findMany({
    where: {
      isPrewarm: false,
      status: { in: ['ready', 'idle'] },
      OR: [
        { lastActivityAt: { lt: suspendBefore } },
        {
          AND: [
            { lastActivityAt: null },
            { createdAt: { lt: suspendBefore } },
          ],
        },
      ],
    },
    take: BATCH,
  });
  for (const inst of idle) {
    logger.info(
      `[reaper] suspending idle instance=${inst.id} sub=${inst.subdomain}`,
    );
    try {
      await suspendInstance(inst.id);
    } catch (err) {
      logger.warn(
        `[reaper] failed to suspend ${inst.id}: ${(err as Error).message}`,
      );
    }
  }

  // 3. Long-forgotten suspended labs → hard-terminate.
  const stale = await prisma.labInstance.findMany({
    where: {
      isPrewarm: false,
      status: 'paused',
      suspendedAt: { lt: hardKillBefore },
    },
    take: BATCH,
  });
  for (const inst of stale) {
    logger.info(
      `[reaper] hard-terminating long-idle instance=${inst.id} ` +
        `sub=${inst.subdomain} suspendedAt=${inst.suspendedAt?.toISOString()}`,
    );
    try {
      await destroyInstance(inst.id, { deleteVolume: true });
    } catch (err) {
      logger.warn(
        `[reaper] failed to hard-terminate ${inst.id}: ${(err as Error).message}`,
      );
    }
  }
}
