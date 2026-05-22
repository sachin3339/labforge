import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
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

  /**
   * POST /api/v1/launches/:id/revoke
   * Permanently disables the launch URL. The next redeem attempt returns
   * 401 `token_revoked`. Already-redeemed students retain their session
   * cookie until it expires; use POST /admin/instances/:id/terminate to
   * boot them immediately.
   */
  app.post('/:id/revoke', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const launch = await prisma.launch.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!launch) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await prisma.launch.update({
      where: { id },
      data: { tokenJti: null, expiresAt: new Date() },
    });
    return { ok: true };
  });

  /**
   * POST /api/v1/launches/:id/regenerate
   * Re-signs the launch with a new jti and new exp window. The old URL
   * stops working immediately (its jti no longer matches the row's
   * tokenJti). Returns the new launchUrl + expiresAt.
   *
   * Use this when:
   *   - the original URL was leaked
   *   - the batch expiry passed and a specific seat needs an extension
   *   - the student lost their URL and a fresh one is easier to email
   */
  app.post('/:id/regenerate', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const body = z
      .object({
        ttlHours: z.number().int().positive().max(8760).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: body.error.issues };
    }
    const launch = await prisma.launch.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!launch) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const ttlSeconds = (body.data.ttlHours ?? 720) * 3600;
    const newJti = nanoid(24);
    const { token, expiresAt } = await signLaunchToken(
      {
        sub: launch.id,
        jti: newJti,
        tenantId: launch.tenantId,
        templateId: launch.templateId,
        userIdHash: launch.userIdHash,
      },
      { ttlSeconds },
    );
    await prisma.launch.update({
      where: { id },
      data: {
        tokenJti: newJti,
        expiresAt,
        // Clear redeemedAt so the new URL counts as a fresh redemption;
        // the redeem route will reuse the existing instance if it's still alive.
        redeemedAt: null,
      },
    });
    const launchUrl = `${config.PUBLIC_API_URL}/launch/redeem?t=${encodeURIComponent(token)}`;
    return { launchId: id, launchUrl, expiresAt: expiresAt.toISOString() };
  });
};
