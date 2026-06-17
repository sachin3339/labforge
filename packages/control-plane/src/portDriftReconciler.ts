import { config } from './config.js';
import { reconcileActiveInstanceNetworkingDrift } from './orchestrator.js';

interface Logger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startPortDriftReconcilerLoop(logger: Logger): void {
  if (!config.PORT_DRIFT_RECONCILE_ENABLED) {
    logger.info('[portDrift] disabled');
    return;
  }

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const res = await reconcileActiveInstanceNetworkingDrift();
      if (res.drifted > 0 || res.guacamoleResynced) {
        logger.warn(
          `[portDrift] reconciled checked=${res.checked} drifted=${res.drifted} ` +
            `guacamoleResynced=${res.guacamoleResynced}`,
        );
      }
    } catch (err) {
      logger.error(`[portDrift] tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  void tick();
  timer = setInterval(tick, config.PORT_DRIFT_RECONCILE_INTERVAL_SECONDS * 1000);
  logger.info(
    `[portDrift] loop started (every ${config.PORT_DRIFT_RECONCILE_INTERVAL_SECONDS}s)`,
  );
}

export function stopPortDriftReconcilerLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
