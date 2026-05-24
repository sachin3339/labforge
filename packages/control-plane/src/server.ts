import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { templateRoutes } from './routes/templates.js';
import { launchRoutes } from './routes/launches.js';
import { batchRoutes } from './routes/batches.js';
import { redeemRoutes } from './routes/redeem.js';
import { internalRoutes } from './routes/internal.js';
import { adminRoutes } from './routes/admin.js';
import { platformRoutes } from './routes/platform.js';
import { gradingRoutes } from './routes/grading.js';
import { reportRoutes } from './routes/reports.js';
import { hostRoutes } from './routes/host.js';
import { startPrewarmLoop, stopPrewarmLoop } from './prewarm.js';
import { startReaperLoop, stopReaperLoop } from './reaper.js';
import { startNodeHealthLoop, stopNodeHealthLoop } from './nodeHealth.js';
import { registerWildcardProxy } from './wildcardProxy.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }
        : undefined,
  },
  trustProxy: true,
  disableRequestLogging: false,
});

await app.register(helmet, {
  // Lab UIs are loaded inside LMS / admin iframes. We control framing via
  // `LAB_FRAME_ANCESTORS` in config and strip upstream X-Frame-Options in
  // the wildcard proxy. Helmet's defaults (X-Frame-Options: SAMEORIGIN +
  // CSP) would block both, so we disable them here.
  contentSecurityPolicy: false,
  frameguard: false,
});
await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
await app.register(rateLimit, {
  global: false,
  max: 60,
  timeWindow: '1 minute',
});

// Wildcard subdomain proxy must register BEFORE other routes so its
// onRequest hook fires first for lab-host requests.
await registerWildcardProxy(app);

await app.register(healthRoutes);
await app.register(redeemRoutes); // /launch/redeem
await app.register(internalRoutes); // /internal/*

await app.register(
  async (scope) => {
    await scope.register(templateRoutes, { prefix: '/templates' });
    await scope.register(launchRoutes, { prefix: '/launches' });
    await scope.register(batchRoutes, { prefix: '/batches' });
    await scope.register(adminRoutes, { prefix: '/admin' });
    await scope.register(platformRoutes, { prefix: '/platform' });
    await scope.register(gradingRoutes, { prefix: '/grading' });
    await scope.register(reportRoutes, { prefix: '/reports' });
    await scope.register(hostRoutes, { prefix: '/host' });
  },
  { prefix: '/api/v1' },
);

const port = config.PORT;
const host = '0.0.0.0';
try {
  await app.listen({ port, host });
  startPrewarmLoop(app.log);
  startReaperLoop(app.log);
  startNodeHealthLoop(app.log);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown — important for k8s preStop hooks later.
const shutdown = async (signal: string) => {
  app.log.info(`[shutdown] signal=${signal}`);
  stopPrewarmLoop();
  stopReaperLoop();
  stopNodeHealthLoop();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
