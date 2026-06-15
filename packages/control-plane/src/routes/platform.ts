import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { authenticateTenant, requirePlatform } from '../auth/apiKey.js';
import { provisionDefaultCatalog } from '../catalog/defaults.js';
import { invalidateNodeRuntime, pingNode } from '../runtime/nodes.js';

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

  // ----- List nodes -----
  app.get('/nodes', async () => {
    const nodes = await prisma.node.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: {
        _count: { select: { instances: true } },
      },
    });
    return { nodes: nodes.map(redactNode) };
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
