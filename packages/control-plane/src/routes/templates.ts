import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { LabTemplateSpec } from '@labforge/shared';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';

const CreateBody = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'lowercase, digits, hyphens'),
  description: z.string().max(2048).optional(),
  spec: LabTemplateSpec,
  /** Pin this template to a specific node. Null/undefined = unpinned. */
  defaultNodeId: z.string().nullable().optional(),
  /**
   * Restrict round-robin scheduling to these nodes. Empty array (or
   * omitted) means "any enabled node". Validated to refer to existing
   * Node rows; unknown ids are rejected with 400.
   */
  allowedNodeIds: z.array(z.string()).optional(),
});

const UpdateBody = z.object({
  description: z.string().max(2048).optional(),
  spec: LabTemplateSpec.optional(),
  defaultNodeId: z.string().nullable().optional(),
  allowedNodeIds: z.array(z.string()).optional(),
});

/**
 * Verify every id in `ids` exists in the Node table. Returns the set of
 * unknown ids (empty when all are valid). De-dupes silently — passing the
 * same id twice is treated as once.
 */
async function findUnknownNodeIds(ids: string[]): Promise<string[]> {
  const unique = Array.from(new Set(ids.filter((s) => s.length > 0)));
  if (unique.length === 0) return [];
  const known = await prisma.node.findMany({
    where: { id: { in: unique } },
    select: { id: true },
  });
  const knownIds = new Set(known.map((n) => n.id));
  return unique.filter((id) => !knownIds.has(id));
}

/**
 * Strip secrets from a template before returning it over the API. The
 * spec.rdpPassword is the only sensitive field we currently embed in
 * spec JSON; it's masked the same way platform.ts redacts sshPassword
 * on Node rows. The orchestrator continues to read the unmasked value
 * directly from the DB row when provisioning.
 */
function redactTemplate<T extends { spec: unknown }>(t: T): T {
  if (!t || typeof t.spec !== 'object' || t.spec === null) return t;
  const spec = t.spec as Record<string, unknown>;
  if (typeof spec.rdpPassword === 'string' && spec.rdpPassword.length > 0) {
    return { ...t, spec: { ...spec, rdpPassword: '***' } };
  }
  return t;
}

export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  app.get('/', async (req) => {
    const tenant = req.tenant!;
    const templates = await prisma.labTemplate.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: 'asc' },
    });
    return { templates: templates.map(redactTemplate) };
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
    return redactTemplate(tpl);
  });

  app.post('/', async (req, reply) => {
    const tenant = req.tenant!;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: parsed.error.issues };
    }

    const allowedNodeIds = parsed.data.allowedNodeIds ?? [];
    const unknown = await findUnknownNodeIds(allowedNodeIds);
    if (unknown.length > 0) {
      reply.code(400);
      return { error: 'unknown_node_ids', unknown };
    }

    const created = await prisma.labTemplate.create({
      data: {
        tenantId: tenant.id,
        name: parsed.data.name,
        description: parsed.data.description,
        spec: parsed.data.spec,
        defaultNodeId: parsed.data.defaultNodeId ?? null,
        allowedNodeIds: Array.from(new Set(allowedNodeIds.filter((s) => s.length > 0))),
      },
    });
    return redactTemplate(created);
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
    if (parsed.data.allowedNodeIds !== undefined) {
      const unknown = await findUnknownNodeIds(parsed.data.allowedNodeIds);
      if (unknown.length > 0) {
        reply.code(400);
        return { error: 'unknown_node_ids', unknown };
      }
    }
    // PATCH bodies that round-trip a previously-redacted template will
    // contain `rdpPassword: "***"` because that's what the GET returned.
    // Preserve the stored secret in that case rather than overwriting it
    // with the mask. Same trick we use for sshPassword on Node rows.
    let mergedSpec = parsed.data.spec as Record<string, unknown> | undefined;
    if (mergedSpec && mergedSpec.rdpPassword === '***') {
      const existingSpec =
        (existing.spec as Record<string, unknown> | null) ?? {};
      mergedSpec = {
        ...mergedSpec,
        rdpPassword: existingSpec.rdpPassword ?? undefined,
      };
    }

    const updated = await prisma.labTemplate.update({
      where: { id },
      data: {
        description: parsed.data.description ?? existing.description,
        spec: mergedSpec ?? (existing.spec as object),
        defaultNodeId:
          parsed.data.defaultNodeId === undefined
            ? existing.defaultNodeId
            : parsed.data.defaultNodeId,
        allowedNodeIds:
          parsed.data.allowedNodeIds === undefined
            ? existing.allowedNodeIds
            : Array.from(new Set(parsed.data.allowedNodeIds.filter((s) => s.length > 0))),
      },
    });
    return redactTemplate(updated);
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
