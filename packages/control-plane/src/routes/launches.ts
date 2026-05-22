import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { LaunchRequest, type LaunchResponse } from '@labforge/shared';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import { hashUserId, signLaunchToken } from '../auth/jwt.js';
import { config } from '../config.js';

export const launchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  /**
   * GET /api/v1/launches
   * Recent launches for the tenant (for admin dashboard).
   */
  app.get('/', async (req) => {
    const tenant = req.tenant!;
    const url = new URL(req.url, 'http://x');
    const take = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const launches = await prisma.launch.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        template: { select: { id: true, name: true } },
        instance: {
          select: { id: true, subdomain: true, status: true, expiresAt: true },
        },
      },
    });
    return { launches };
  });

  /**
   * POST /api/v1/launches
   * Returns a single-use launch URL the LMS hands back to the student.
   * Token is short-lived (default 60s); browser must hit /launch/redeem
   * before it expires.
   */
  app.post('/', async (req, reply) => {
    const tenant = req.tenant!;
    const parsed = LaunchRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: parsed.error.issues };
    }
    const body = parsed.data;

    const template = await prisma.labTemplate.findFirst({
      where: { id: body.templateId, tenantId: tenant.id },
    });
    if (!template) {
      reply.code(404);
      return { error: 'template_not_found' };
    }

    const durationMinutes = Math.min(
      body.durationMinutes,
      config.LAB_MAX_DURATION_MINUTES,
    );
    const launchId = nanoid(16);
    const jti = nanoid(24);
    const userIdHash = hashUserId(body.userId);

    const { token, expiresAt } = await signLaunchToken({
      sub: launchId,
      jti,
      tenantId: tenant.id,
      templateId: template.id,
      userIdHash,
    });

    await prisma.launch.create({
      data: {
        id: launchId,
        tenantId: tenant.id,
        templateId: template.id,
        userIdHash,
        userDisplayName: body.userDisplayName,
        durationMinutes,
        returnUrl: body.returnUrl,
        webhookUrl: body.webhookUrl,
        context: body.context ?? {},
        tokenJti: jti,
        expiresAt,
      },
    });

    const launchUrl = `${config.PUBLIC_API_URL}/launch/redeem?t=${encodeURIComponent(token)}`;
    const resp: LaunchResponse = {
      launchId,
      launchUrl,
      expiresAt: expiresAt.toISOString(),
    };
    return resp;
  });
};
