import { prisma } from './db.js';
import { config } from './config.js';
import { pingNode, invalidateNodeRuntime } from './runtime/nodes.js';

/**
 * Background poller that keeps `Node.lastSeenAt` / `lastError` /
 * `dockerVersion` fresh. Two downstream consumers depend on this data:
 *
 *   1. The admin UI status dot — operators see green/red without manually
 *      hitting "Test connection".
 *   2. The load-spread scheduler (`pickLeastLoadedNode`) — only nodes with
 *      a recent lastSeenAt are eligible for new placements, so a wedged or
 *      unreachable host is automatically taken out of rotation.
 *
 * Per-node ping is wrapped in its own try so one dead host can't poison
 * the rest of the tick. Cached dockerode clients are invalidated on
 * failure so the NEXT poll re-opens the SSH channel from scratch (avoids
 * a stuck client masking a recovered host).
 */

interface Logger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

let timer: NodeJS.Timeout | null = null;

export function startNodeHealthLoop(logger: Logger): void {
  const intervalSec = config.NODE_HEALTH_INTERVAL_SECONDS;
  const tick = async () => {
    try {
      await pollAllNodes(logger);
    } catch (err) {
      logger.error(`[nodeHealth] tick failed: ${(err as Error).message}`);
    }
  };
  // Kick once immediately so the first scheduler call after boot already
  // has fresh data (otherwise the first ~30s of provisions would skip
  // every node as "stale").
  void tick();
  timer = setInterval(tick, intervalSec * 1000);
  logger.info(`[nodeHealth] loop started (every ${intervalSec}s)`);
}

export function stopNodeHealthLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function pollAllNodes(logger: Logger): Promise<void> {
  const nodes = await prisma.node.findMany({ where: { enabled: true } });
  if (nodes.length === 0) return;

  // Ping all in parallel — each ping has its own short SSH timeout so the
  // whole tick can't run longer than ~10s even with several dead hosts.
  await Promise.all(
    nodes.map(async (n) => {
      const res = await pingNode(n);
      try {
        if (res.ok) {
          await prisma.node.update({
            where: { id: n.id },
            data: {
              lastSeenAt: new Date(),
              lastError: null,
              dockerVersion: res.version,
            },
          });
        } else {
          await prisma.node.update({
            where: { id: n.id },
            data: { lastError: truncate(res.error, 500) },
          });
          // Force a fresh dockerode client next time — a wedged SSH
          // channel could otherwise mask a recovered host indefinitely.
          invalidateNodeRuntime(n.id);
          logger.warn(`[nodeHealth] ${n.name} unreachable: ${res.error}`);
        }
      } catch (err) {
        logger.error(
          `[nodeHealth] failed to persist ping for ${n.name}: ${(err as Error).message}`,
        );
      }
    }),
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
