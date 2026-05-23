import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import { nanoid } from 'nanoid';
import {
  destroyInstance,
  extendInstance,
  getInstanceLogs,
  instanceUrl,
  restartInstance,
  resumeInstance,
  suspendInstance,
} from '../orchestrator.js';

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
      tenant: { id: tenant.id, name: tenant.name, role: tenant.role },
      stats: {
        templates: templateCount,
        activeInstances: instanceCount,
        launchesLast24h: recentLaunches,
      },
    };
  });

  // ----- Instance list with filters -----
  app.get('/instances', async (req) => {
    const tenant = req.tenant!;
    const url = new URL(req.url, 'http://x');
    const take = Math.min(Number(url.searchParams.get('limit') ?? '100'), 500);
    const status = url.searchParams.get('status'); // comma-separated
    const templateId = url.searchParams.get('templateId');
    const includeTerminated = url.searchParams.get('includeTerminated') === '1';

    const where: Record<string, unknown> = { tenantId: tenant.id };
    if (templateId) where.templateId = templateId;
    if (status) {
      where.status = { in: status.split(',') };
    } else if (!includeTerminated) {
      where.status = {
        notIn: ['terminated', 'failed'],
      };
    }

    const instances = await prisma.labInstance.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        template: { select: { id: true, name: true } },
        launch: {
          select: {
            id: true,
            userDisplayName: true,
            userIdHash: true,
            context: true,
          },
        },
      },
    });
    return { instances };
  });

  // ----- Instance detail -----
  app.get('/instances/:id', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const instance = await prisma.labInstance.findFirst({
      where: { id, tenantId: tenant.id },
      include: {
        template: true,
        launch: true,
      },
    });
    if (!instance) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return {
      instance,
      url: instanceUrl(instance.subdomain),
    };
  });

  // ----- Instance: tail container logs -----
  app.get('/instances/:id/logs', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const url = new URL(req.url, 'http://x');
    const tail = Math.min(Math.max(Number(url.searchParams.get('tail') ?? '200'), 1), 5000);
    const instance = await prisma.labInstance.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true, runtimeId: true },
    });
    if (!instance) {
      reply.code(404);
      return { error: 'not_found' };
    }
    try {
      const logs = await getInstanceLogs(instance.id, tail);
      return { logs, tail };
    } catch (err) {
      reply.code(500);
      return { error: 'logs_failed', detail: (err as Error).message };
    }
  });

  // ----- Instance: force suspend -----
  app.post('/instances/:id/suspend', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const owns = await prisma.labInstance.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true },
    });
    if (!owns) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await suspendInstance(id);
    return { ok: true };
  });

  // ----- Instance: force resume -----
  app.post('/instances/:id/resume', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const owns = await prisma.labInstance.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true, runtimeId: true },
    });
    if (!owns) {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (!owns.runtimeId) {
      reply.code(409);
      return { error: 'no_runtime' };
    }
    try {
      const inst = await resumeInstance(id, { waitMs: 0 });
      return { ok: true, status: inst.status };
    } catch (err) {
      reply.code(500);
      return { error: 'resume_failed', detail: (err as Error).message };
    }
  });

  // ----- Instance: restart in place (preserve volume + subdomain) -----
  app.post('/instances/:id/restart', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const owns = await prisma.labInstance.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true, runtimeId: true },
    });
    if (!owns) {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (!owns.runtimeId) {
      reply.code(409);
      return { error: 'no_runtime' };
    }
    try {
      await restartInstance(id);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: 'restart_failed', detail: (err as Error).message };
    }
  });

  // ----- Instance: terminate (optionally wipe per-user volume) -----
  app.post('/instances/:id/terminate', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const body = z
      .object({ deleteVolume: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body' };
    }
    const owns = await prisma.labInstance.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true },
    });
    if (!owns) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await destroyInstance(id, { deleteVolume: body.data.deleteVolume });
    return { ok: true };
  });

  // ----- Instance: extend expiry -----
  app.post('/instances/:id/extend', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const body = z
      .object({
        // Either an absolute new expiresAt or a relative bump in hours.
        expiresAt: z.string().datetime().optional(),
        extendHours: z.number().int().positive().max(8760).optional(),
      })
      .refine((b) => b.expiresAt || b.extendHours, {
        message: 'one of expiresAt or extendHours required',
      })
      .safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: body.error.issues };
    }
    const inst = await prisma.labInstance.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!inst) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const newExp = body.data.expiresAt
      ? new Date(body.data.expiresAt)
      : new Date(inst.expiresAt.getTime() + body.data.extendHours! * 3600_000);
    const updated = await extendInstance(id, newExp);
    return { ok: true, expiresAt: updated.expiresAt.toISOString() };
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
