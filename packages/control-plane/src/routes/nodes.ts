import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import { config } from '../config.js';

/**
 * Tenant-facing, read-only node directory. The LMS/API integration calls
 * this to discover the node *names* it can pass in `nodeNames` on a launch
 * or batch request (request-level placement override + round-robin).
 *
 * Auth: any valid tenant API key (same key used for launches/batches).
 * Unlike `/api/v1/platform/nodes`, this does NOT require the platform
 * super-admin role, and it never returns connection/secret fields
 * (sshHost, sshUser, sshPassword, sshKeyPath, proxyHost, bindIp, …) —
 * only what a caller needs to choose a placement target.
 */
export const nodeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  // ----- List nodes (placement targets) -----
  app.get('/', async () => {
    const staleCutoff = new Date(Date.now() - config.NODE_HEALTH_STALE_SECONDS * 1000);

    const nodes = await prisma.node.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: {
        name: true,
        isDefault: true,
        enabled: true,
        capacityMax: true,
        lastSeenAt: true,
        _count: { select: { instances: { where: { status: { notIn: ['terminated', 'failed'] } } } } },
      },
    });

    return {
      nodes: nodes.map((n) => {
        // Mirror the scheduler's eligibility definition: a node is healthy
        // if it has pinged recently, OR has never pinged yet (lastSeenAt
        // null = brand-new node allowed to bootstrap work).
        const healthy = n.lastSeenAt === null || n.lastSeenAt >= staleCutoff;
        const active = n._count.instances;
        const atCapacity = n.capacityMax > 0 && active >= n.capacityMax;
        return {
          name: n.name,
          isDefault: n.isDefault,
          enabled: n.enabled,
          healthy,
          capacityMax: n.capacityMax, // 0 = unlimited
          activeInstances: active,
          // Remaining slots; null when capacity is unlimited.
          available: n.capacityMax > 0 ? Math.max(n.capacityMax - active, 0) : null,
          // True when the scheduler would currently place a fresh instance
          // here (use this to filter the nodeNames you send).
          acceptingNew: n.enabled && healthy && !atCapacity,
        };
      }),
    };
  });
};
