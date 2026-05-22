import { LabTemplateSpec } from '@labforge/shared';
import { prisma } from './db.js';
import { config } from './config.js';
import { provisionNew } from './orchestrator.js';

/**
 * Pre-warm pool reconciler. Every PREWARM_INTERVAL_SECONDS it walks every
 * template and ensures the desired number of "ready" prewarm instances exist.
 *
 * Sized intentionally for p95 launches/hr — not peak. Cold starts (~5-15s
 * for code-server) are acceptable for the long tail.
 */
let timer: NodeJS.Timeout | null = null;

export function startPrewarmLoop(logger: { info: (m: string) => void; error: (m: string) => void }) {
  if (!config.PREWARM_ENABLED) {
    logger.info('[prewarm] disabled');
    return;
  }
  const tick = async () => {
    try {
      await reconcileOnce();
    } catch (err) {
      logger.error(`[prewarm] reconcile failed: ${(err as Error).message}`);
    }
  };
  void tick();
  timer = setInterval(tick, config.PREWARM_INTERVAL_SECONDS * 1000);
  logger.info(
    `[prewarm] loop started (every ${config.PREWARM_INTERVAL_SECONDS}s)`,
  );
}

export function stopPrewarmLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function reconcileOnce() {
  const templates = await prisma.labTemplate.findMany();
  for (const tmpl of templates) {
    let spec;
    try {
      spec = LabTemplateSpec.parse(tmpl.spec);
    } catch {
      continue; // invalid spec; skip rather than crash the loop
    }
    if (spec.prewarm <= 0) continue;

    const current = await prisma.labInstance.count({
      where: {
        templateId: tmpl.id,
        isPrewarm: true,
        status: { in: ['provisioning', 'ready'] },
      },
    });
    const need = spec.prewarm - current;
    if (need <= 0) continue;

    // Cap creation per tick to avoid thundering herd on startup.
    const toCreate = Math.min(need, 2);
    for (let i = 0; i < toCreate; i += 1) {
      await provisionNew({
        tenantId: tmpl.tenantId,
        template: tmpl,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        isPrewarm: true,
      });
    }
  }
}
