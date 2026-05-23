import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { authenticateTenant, requirePlatform } from '../auth/apiKey.js';
import { provisionDefaultCatalog } from '../catalog/defaults.js';

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

  // ----- Update tenant name / role -----
  app.patch('/tenants/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        role: z.enum(['tenant', 'platform']).optional(),
      })
      .parse(req.body);
    try {
      const tenant = await prisma.tenant.update({ where: { id }, data: body });
      return { tenant: { id: tenant.id, name: tenant.name, role: tenant.role } };
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
};

/** Hex-encoded 32-byte random key. */
function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}
