import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { LaunchRequest, type LaunchResponse } from '@labforge/shared';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import { hashUserId, signLaunchToken } from '../auth/jwt.js';
import { config } from '../config.js';
import { emitUsage } from '../metering.js';
import { acquireInstance, resumeInstance, runtimeFor, waitUntilReady } from '../orchestrator.js';

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
          select: {
            id: true,
            subdomain: true,
            status: true,
            expiresAt: true,
            node: { select: { id: true, name: true } },
          },
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

    emitUsage({
      tenantId: tenant.id,
      kind: 'launch_created',
      launchId,
      templateId: template.id,
      userIdHash,
      payload: { durationMinutes },
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

  /**
   * POST /api/v1/launches/:id/prepare
   *
   * Eagerly provisions (or resumes) the lab for this launch BEFORE the
   * student clicks the URL. Use this to remove the cold-start wait when
   * sharing URLs in advance. The launch is linked to the resulting
   * instance but `redeemedAt` stays null (the student's first click still
   * counts as the redemption for billing).
   *
   * Body: { waitSeconds?: number } — when >0, blocks until the upstream
   * is reachable so the response only returns once the lab is truly
   * student-ready. Defaults to 0 (return as soon as the row exists).
   */
  app.post('/:id/prepare', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const body = z
      .object({ waitSeconds: z.number().int().min(0).max(120).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: body.error.issues };
    }
    const waitSeconds = body.data.waitSeconds ?? 0;

    const launch = await prisma.launch.findFirst({
      where: { id, tenantId: tenant.id },
      include: { template: true, instance: true },
    });
    if (!launch) {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (launch.expiresAt.getTime() <= Date.now()) {
      reply.code(410);
      return { error: 'launch_expired' };
    }

    let instance = launch.instance;
    const reusable =
      instance &&
      ['pending', 'provisioning', 'ready', 'idle', 'paused'].includes(
        instance.status,
      );
    if (!reusable) {
      try {
        instance = await acquireInstance({
          tenantId: launch.tenantId,
          template: launch.template,
          userIdHash: launch.userIdHash,
          durationMinutes: launch.durationMinutes,
          expiresAt: launch.expiresAt,
        });
      } catch (err) {
        reply.code(500);
        return { error: 'provision_failed', detail: (err as Error).message };
      }
      await prisma.launch.update({
        where: { id: launch.id },
        data: { instanceId: instance.id },
      });
    } else if (instance!.status === 'paused' && instance!.runtimeId) {
      try {
        instance = await resumeInstance(instance!.id, {
          waitMs: waitSeconds * 1000,
        });
      } catch (err) {
        reply.code(503);
        return { error: 'resume_failed', detail: (err as Error).message };
      }
    }

    let ready = instance!.status === 'ready' || instance!.status === 'idle';
    if (waitSeconds > 0 && instance!.runtimeId && instance!.upstream && !ready) {
      const spec = (launch.template.spec ?? {}) as { upstreamScheme?: 'http' | 'https' };
      const scheme: 'http' | 'https' = spec.upstreamScheme === 'https' ? 'https' : 'http';
      // Use the per-node runtime so inspect() hits the right docker daemon
      // (instance may live on a remote worker node).
      const runtime = await runtimeFor(instance!);
      ready = await waitUntilReady(
        instance!.runtimeId,
        instance!.upstream,
        waitSeconds * 1000,
        scheme,
        runtime,
      );
      if (ready) {
        instance = await prisma.labInstance.findUniqueOrThrow({
          where: { id: instance!.id },
        });
      }
    }

    return {
      launchId: launch.id,
      instanceId: instance!.id,
      subdomain: instance!.subdomain,
      status: instance!.status,
      ready,
    };
  });

  /**
   * POST /api/v1/launches/:id/preview-url
   *
   * Mints a short-lived redeem URL for admin preview / "open lab" buttons.
   * Reuses the launch's existing `tokenJti` so the redeem check passes
   * without modifying any DB row (the student's distributed URL keeps
   * working). Returns 409 if the launch was revoked.
   */
  app.post('/:id/preview-url', async (req, reply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };
    const launch = await prisma.launch.findFirst({
      where: { id, tenantId: tenant.id },
      include: {
        template: { select: { name: true } },
        // Pull node off the bound instance (may be null if the launch
        // hasn't been redeemed yet — caller renders "—" in that case).
        instance: {
          select: {
            node: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!launch) {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (!launch.tokenJti) {
      reply.code(409);
      return { error: 'revoked' };
    }
    const { token, expiresAt } = await signLaunchToken(
      {
        sub: launch.id,
        jti: launch.tokenJti,
        tenantId: launch.tenantId,
        templateId: launch.templateId,
        userIdHash: launch.userIdHash,
      },
      { ttlSeconds: 300 }, // 5 minutes — admin preview only
    );
    const url = `${config.PUBLIC_API_URL}/launch/redeem?t=${encodeURIComponent(token)}`;
    return {
      url,
      expiresAt: expiresAt.toISOString(),
      templateName: launch.template?.name ?? null,
      node: launch.instance?.node ?? null,
    };
  });
};
