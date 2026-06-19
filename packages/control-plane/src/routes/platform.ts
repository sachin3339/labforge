import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { authenticateTenant, requirePlatform } from '../auth/apiKey.js';
import { provisionDefaultCatalog } from '../catalog/defaults.js';
import { invalidateNodeRuntime, pingNode } from '../runtime/nodes.js';
import { config } from '../config.js';

/**
 * Platform-admin routes. Only tenants with `role='platform'` may call these.
 * Used by the super-admin UI to manage downstream tenants (clients).
 */
export const platformRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);
  app.addHook('preHandler', requirePlatform);

  // ----- List tenants -----
  app.get('/tenants', async () => {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        apiKey: true,
        role: true,
        createdAt: true,
        _count: {
          select: { templates: true, instances: true, launches: true },
        },
      },
    });
    return { tenants };
  });

  // ----- Create tenant -----
  app.post('/tenants', async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(100),
        role: z.enum(['tenant', 'platform']).default('tenant'),
      })
      .parse(req.body);

    const apiKey = generateApiKey();
    const tenant = await prisma.tenant.create({
      data: { name: body.name, apiKey, role: body.role },
    });
    // Every new tenant ships with the standard catalog (Ubuntu, Kali,
    // Windows, VS Code, Jupyter, terminal). They can edit / delete /
    // add to it from the templates UI.
    await provisionDefaultCatalog(prisma, tenant.id, 'create-only');
    reply.code(201);
    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        apiKey: tenant.apiKey,
        role: tenant.role,
        createdAt: tenant.createdAt,
      },
    };
  });

  // ----- Get tenant detail -----
  app.get('/tenants/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        apiKey: true,
        role: true,
        webhookSecret: true,
        createdAt: true,
        _count: {
          select: { templates: true, instances: true, launches: true },
        },
      },
    });
    if (!tenant) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { tenant };
  });

  // ----- Update tenant name / role / default node -----
  app.patch('/tenants/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        role: z.enum(['tenant', 'platform']).optional(),
        /** null clears the pin; undefined leaves it alone. */
        defaultNodeId: z.string().nullable().optional(),
      })
      .parse(req.body);
    try {
      const tenant = await prisma.tenant.update({ where: { id }, data: body });
      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          role: tenant.role,
          defaultNodeId: tenant.defaultNodeId,
        },
      };
    } catch {
      reply.code(404);
      return { error: 'not_found' };
    }
  });

  // ----- Rotate API key -----
  app.post('/tenants/:id/rotate-key', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const apiKey = generateApiKey();
    try {
      const tenant = await prisma.tenant.update({
        where: { id },
        data: { apiKey },
      });
      return { tenant: { id: tenant.id, apiKey: tenant.apiKey } };
    } catch {
      reply.code(404);
      return { error: 'not_found' };
    }
  });

  // ----- Delete tenant (cascades to templates/instances/launches) -----
  app.delete('/tenants/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    // Refuse to delete the calling platform tenant — would lock the UI out.
    if (req.tenant!.id === id) {
      reply.code(400);
      return { error: 'cannot_delete_self' };
    }
    try {
      await prisma.tenant.delete({ where: { id } });
      reply.code(204);
      return null;
    } catch {
      reply.code(404);
      return { error: 'not_found' };
    }
  });

  // ============================================================
  //   Node management — physical Docker hosts the scheduler can
  //   land lab containers on.
  // ============================================================

  // ----- List nodes (with live load + health stats) -----
  // The per-node `_count.instances` Prisma gives us is ALL-TIME (it counts
  // terminated/failed rows too), which made the UI show wildly inflated
  // "live container" numbers. We instead group instances by (node, status,
  // isPrewarm) and derive real live/claimed/prewarm counts + capacity
  // utilisation + health so operators can size the fleet accurately.
  app.get('/nodes', async () => {
    const [nodes, grouped] = await Promise.all([
      prisma.node.findMany({
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      prisma.labInstance.groupBy({
        by: ['nodeId', 'status', 'isPrewarm'],
        _count: { _all: true },
      }),
    ]);

    const staleCutoff = new Date(Date.now() - config.NODE_HEALTH_STALE_SECONDS * 1000);
    // Rows in these statuses occupy no host resources — exclude from "live".
    const DEAD = new Set(['terminated', 'failed']);

    const nodesOut = nodes.map((n) => {
      const rows = grouped.filter((g) => g.nodeId === n.id);
      const byStatus: Record<string, number> = {};
      let live = 0; // running containers (non-terminated, non-failed)
      let prewarm = 0; // live warm-pool spares (no student yet)
      let allTime = 0; // every row ever, for reference
      for (const r of rows) {
        const c = r._count._all;
        allTime += c;
        byStatus[r.status] = (byStatus[r.status] ?? 0) + c;
        if (!DEAD.has(r.status)) {
          live += c;
          if (r.isPrewarm) prewarm += c;
        }
      }
      // claimed = live student-occupied containers (live minus warm spares).
      const claimed = Math.max(live - prewarm, 0);
      const healthy = n.lastSeenAt === null || n.lastSeenAt >= staleCutoff;
      const available = n.capacityMax > 0 ? Math.max(n.capacityMax - live, 0) : null;
      const utilizationPct =
        n.capacityMax > 0 ? Math.round((live / n.capacityMax) * 100) : null;
      return {
        ...redactNode(n),
        // Back-compat: keep the old shape but make it mean LIVE, not all-time.
        _count: { instances: live },
        stats: {
          live,
          claimed,
          prewarm,
          allTime,
          byStatus,
          capacityMax: n.capacityMax,
          available,
          utilizationPct,
          healthy,
          lastSeenAt: n.lastSeenAt,
          lastError: n.lastError,
          dockerVersion: n.dockerVersion,
        },
      };
    });
    return { nodes: nodesOut };
  });

  // ----- Create node -----
  app.post('/nodes', async (req, reply) => {
    const body = NodeWriteBody.parse(req.body);
    // If the new node is marked default, clear any existing default first —
    // we never want two rows fighting over the implicit fallback.
    if (body.isDefault) {
      await prisma.node.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    const node = await prisma.node.create({ data: body });
    reply.code(201);
    return { node: redactNode(node) };
  });

  // ----- Update node -----
  app.patch('/nodes/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = NodeWriteBody.partial().parse(req.body);
    // Empty-string sshPassword from a form submit means "no change" — drop
    // it from the update so we don't accidentally clear a stored secret
    // every time the operator touches an unrelated field. Explicit `null`
    // still clears (used by a "Remove password" affordance).
    if (typeof body.sshPassword === 'string' && body.sshPassword === '') {
      delete (body as { sshPassword?: unknown }).sshPassword;
    }
    try {
      if (body.isDefault === true) {
        await prisma.node.updateMany({
          where: { isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }
      const node = await prisma.node.update({ where: { id }, data: body });
      // Connection settings may have changed — force a fresh dockerode
      // client next time anyone hits this node.
      invalidateNodeRuntime(id);
      return { node: redactNode(node) };
    } catch {
      reply.code(404);
      return { error: 'not_found' };
    }
  });

  // ----- Test connection -----
  app.post('/nodes/:id/ping', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const node = await prisma.node.findUnique({ where: { id } });
    if (!node) {
      reply.code(404);
      return { error: 'not_found' };
    }
    invalidateNodeRuntime(id);
    return pingNode(node);
  });

  // ----- Delete node -----
  app.delete('/nodes/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const count = await prisma.labInstance.count({
      where: { nodeId: id, status: { notIn: ['terminated', 'failed'] } },
    });
    if (count > 0) {
      reply.code(409);
      return { error: 'node_in_use', activeInstances: count };
    }
    try {
      await prisma.node.delete({ where: { id } });
      invalidateNodeRuntime(id);
      reply.code(204);
      return null;
    } catch {
      reply.code(404);
      return { error: 'not_found' };
    }
  });

  // ============================================================
  //   Guacamole gateway — singleton config row used by the
  //   redeem flow when a template's resolved viewer is
  //   `guacamole-rdp`.
  // ============================================================

  // ----- Get singleton -----
  app.get('/guacamole', async () => {
    const row = await prisma.guacamoleConfig.findUnique({
      where: { id: 'singleton' },
    });
    return { config: row ? redactGuacamole(row) : null };
  });

  // ----- Create/update singleton -----
  app.put('/guacamole', async (req) => {
    const body = GuacamoleWriteBody.parse(req.body);
    // Same "empty string = keep stored secret" semantics as nodes.
    if (typeof body.sshPassword === 'string' && body.sshPassword === '') {
      delete (body as { sshPassword?: unknown }).sshPassword;
    }
    const row = await prisma.guacamoleConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...body },
      update: body,
    });
    return { config: redactGuacamole(row) };
  });

  // ----- Resync user-mapping.xml on demand -----
  // Useful when an operator has edited the file out-of-band and wants the
  // canonical state restored, or after fixing a transient SSH outage.
  app.post('/guacamole/resync', async (_req, reply) => {
    // Lazy-import to avoid pulling node-shell deps into routes that
    // don't need them.
    const { regenerateUserMapping } = await import('../runtime/guacamole.js');
    try {
      const r = await regenerateUserMapping(prisma);
      return { ok: true, ...r };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });
};

/**
 * Shared validator for node create/update. Operators only fill the SSH
 * fields when `connectionMode='ssh'`; the local mode ignores them.
 *
 * `sshPassword` is treated specially: an empty/missing value on PATCH
 * means "leave unchanged" (so editors don't have to retype on every
 * save). Send explicit `null` to clear it.
 */
const NodeWriteBody = z.object({
  name: z.string().min(1).max(64),
  isDefault: z.boolean().default(false),
  connectionMode: z.enum(['local', 'ssh']).default('local'),
  sshHost: z.string().nullable().optional(),
  sshUser: z.string().nullable().optional(),
  sshPort: z.number().int().min(1).max(65535).nullable().optional(),
  sshKeyPath: z.string().nullable().optional(),
  sshPassword: z.string().nullable().optional(),
  proxyHost: z.string().min(1).default('127.0.0.1'),
  bindIp: z.string().min(1).default('127.0.0.1'),
  capacityMax: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  notes: z.string().nullable().optional(),
});

/**
 * Strip secret fields before any node payload leaves the control-plane.
 * sshPassword is the only true secret on the row (sshKeyPath is just a
 * filesystem path on the control-plane host).
 */
function redactNode<T extends { sshPassword?: string | null }>(node: T): Omit<T, 'sshPassword'> {
  const { sshPassword: _omit, ...safe } = node;
  return safe;
}

/** Hex-encoded 32-byte random key. */
function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Validator for GET/PUT on the singleton Guacamole config row. All
 * fields are optional on PUT — operators set up the gateway in stages
 * (publicUrl + userMappingPath first, SSH later when remote-write).
 */
const GuacamoleWriteBody = z.object({
  publicUrl: z.string().url(),
  userMappingPath: z.string().min(1),
  sshHost: z.string().nullable().optional(),
  sshUser: z.string().nullable().optional(),
  sshPort: z.number().int().min(1).max(65535).nullable().optional(),
  sshKeyPath: z.string().nullable().optional(),
  sshPassword: z.string().nullable().optional(),
  defaultRdpHost: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});

/** Strip the only true secret before responding. */
function redactGuacamole<T extends { sshPassword?: string | null }>(
  row: T,
): Omit<T, 'sshPassword'> {
  const { sshPassword: _omit, ...safe } = row;
  return safe;
}
