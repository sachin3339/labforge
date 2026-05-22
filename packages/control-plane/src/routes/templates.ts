import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { LabTemplateSpec } from '@labforge/shared';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';

const CreateBody = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'lowercase, digits, hyphens'),
  description: z.string().max(2048).optional(),
  spec: LabTemplateSpec,
});

const UpdateBody = z.object({
  description: z.string().max(2048).optional(),
  spec: LabTemplateSpec.optional(),
});

export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  app.get('/', async (req) => {
    const tenant = req.tenant!;
    const templates = await prisma.labTemplate.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: 'asc' },
    });
    return { templates };
  });

  app.get('/:id', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const tpl = await prisma.labTemplate.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!tpl) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return tpl;
  });

  app.post('/', async (req, reply) => {
    const tenant = req.tenant!;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: parsed.error.issues };
    }

    const created = await prisma.labTemplate.create({
      data: {
        tenantId: tenant.id,
        name: parsed.data.name,
        description: parsed.data.description,
        spec: parsed.data.spec,
      },
    });
    return created;
  });

  app.patch('/:id', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: parsed.error.issues };
    }
    const existing = await prisma.labTemplate.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const updated = await prisma.labTemplate.update({
      where: { id },
      data: {
        description: parsed.data.description ?? existing.description,
        spec: parsed.data.spec ?? (existing.spec as object),
      },
    });
    return updated;
  });

  app.delete('/:id', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const existing = await prisma.labTemplate.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await prisma.labTemplate.delete({ where: { id } });
    reply.code(204);
    return;
  });
};
