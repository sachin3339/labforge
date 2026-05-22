import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import { gradeInstance, GraderError } from '../grader.js';

/**
 * Grading routes. All auth'd with the tenant API key.
 *   POST /api/v1/grading/instances/:instanceId   — run grader against instance
 *   POST /api/v1/grading/launches/:launchId      — convenience: grade via launch id
 *   GET  /api/v1/grading/instances/:instanceId   — list past grades for instance
 *   GET  /api/v1/grading/launches/:launchId      — list past grades for launch
 */
export const gradingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  app.post<{ Params: { instanceId: string } }>(
    '/instances/:instanceId',
    async (req, reply) => {
      const tenant = req.tenant!;
      const instance = await prisma.labInstance.findFirst({
        where: { id: req.params.instanceId, tenantId: tenant.id },
        include: { template: true, launch: true },
      });
      if (!instance) {
        reply.code(404);
        return { error: 'instance_not_found' };
      }
      try {
        const outcome = await gradeInstance({
          tenant,
          template: instance.template,
          instance,
          launch: instance.launch,
        });
        return outcome;
      } catch (err) {
        if (err instanceof GraderError) {
          reply.code(409);
          return { error: err.code, message: err.message };
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { launchId: string } }>(
    '/launches/:launchId',
    async (req, reply) => {
      const tenant = req.tenant!;
      const launch = await prisma.launch.findFirst({
        where: { id: req.params.launchId, tenantId: tenant.id },
        include: { template: true, instance: true },
      });
      if (!launch) {
        reply.code(404);
        return { error: 'launch_not_found' };
      }
      if (!launch.instance) {
        reply.code(409);
        return { error: 'launch_not_redeemed' };
      }
      try {
        const outcome = await gradeInstance({
          tenant,
          template: launch.template,
          instance: launch.instance,
          launch,
        });
        return outcome;
      } catch (err) {
        if (err instanceof GraderError) {
          reply.code(409);
          return { error: err.code, message: err.message };
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { instanceId: string } }>(
    '/instances/:instanceId',
    async (req, reply) => {
      const tenant = req.tenant!;
      const instance = await prisma.labInstance.findFirst({
        where: { id: req.params.instanceId, tenantId: tenant.id },
        select: { id: true },
      });
      if (!instance) {
        reply.code(404);
        return { error: 'instance_not_found' };
      }
      const results = await prisma.gradingResult.findMany({
        where: { instanceId: instance.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return { results };
    },
  );

  app.get<{ Params: { launchId: string } }>(
    '/launches/:launchId',
    async (req, reply) => {
      const tenant = req.tenant!;
      const launch = await prisma.launch.findFirst({
        where: { id: req.params.launchId, tenantId: tenant.id },
        select: { id: true },
      });
      if (!launch) {
        reply.code(404);
        return { error: 'launch_not_found' };
      }
      const results = await prisma.gradingResult.findMany({
        where: { launchId: launch.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return { results };
    },
  );
};
