import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import { nanoid } from 'nanoid';

/**
 * Admin-only routes consumed by the tenant admin UI. All require a valid
 * tenant API key (same auth as the LMS-facing routes).
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  // Identify the tenant behind a key — used by the admin UI on login.
  app.get('/me', async (req) => {
    const tenant = req.tenant!;
    const [templateCount, instanceCount, recentLaunches] = await Promise.all([
      prisma.labTemplate.count({ where: { tenantId: tenant.id } }),
      prisma.labInstance.count({
        where: {
          tenantId: tenant.id,
          status: { in: ['pending', 'provisioning', 'ready', 'idle'] },
        },
      }),
      prisma.launch.count({
        where: {
          tenantId: tenant.id,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
    return {
      tenant: { id: tenant.id, name: tenant.name },
      stats: {
        templates: templateCount,
        activeInstances: instanceCount,
        launchesLast24h: recentLaunches,
      },
    };
  });

  // Current + recent instances for the admin "Live labs" view.
  app.get('/instances', async (req) => {
    const tenant = req.tenant!;
    const url = new URL(req.url, 'http://x');
    const take = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const instances = await prisma.labInstance.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        template: { select: { id: true, name: true } },
        launch: {
          select: { id: true, userDisplayName: true, userIdHash: true },
        },
      },
    });
    return { instances };
  });

  // Rotate the tenant API key.
  app.post('/rotate-key', async (req) => {
    const tenant = req.tenant!;
    const newKey = `lf_${nanoid(32)}`;
    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: { apiKey: newKey },
    });
    return { apiKey: updated.apiKey };
  });
};
