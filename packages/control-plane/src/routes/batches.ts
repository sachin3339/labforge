import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import {
  BatchLaunchRequest,
  type BatchLaunchItem,
  type BatchLaunchResponse,
  type BatchSummary,
} from '@labforge/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import { hashUserId, signLaunchToken } from '../auth/jwt.js';
import { config } from '../config.js';

/**
 * Admin-issued bulk launch URLs. One call → N single-use, long-lived
 * (default 24h) URLs that an operator can hand to a corporate client
 * to embed in their LMS / email out to learners.
 *
 * Each URL is independent: redeeming it provisions a container, sets the
 * lf_session cookie, and redirects to the lab subdomain — exactly the
 * same flow as a single launch from the LMS.
 *
 * Batches are NOT a separate DB table — we store the batchId + label in
 * each Launch's `context` JSON. This keeps the schema migration-free while
 * preserving grouping for the admin UI.
 */
export const batchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  // ----- List batches -----
  app.get('/', async (req) => {
    const tenant = req.tenant!;
    // Pull all launches that carry a batchId and aggregate in memory. Cheap
    // for the seat counts we target (thousands of launches per tenant); if
    // this ever gets hot, push to a materialised view.
    const launches = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], not: Prisma.JsonNull },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        template: { select: { id: true, name: true } },
        instance: { select: { status: true } },
      },
      take: 5_000,
    });

    const groups = new Map<string, BatchSummary & { _times: Date[] }>();
    for (const l of launches) {
      const ctx = (l.context ?? {}) as Record<string, unknown>;
      const batchId = String(ctx.batchId ?? '');
      if (!batchId) continue;

      const existing = groups.get(batchId);
      const active =
        l.instance && ['pending', 'provisioning', 'ready', 'idle'].includes(l.instance.status)
          ? 1
          : 0;
      const redeemed = l.redeemedAt ? 1 : 0;

      if (existing) {
        existing.count += 1;
        existing.redeemed += redeemed;
        existing.active += active;
        existing._times.push(l.createdAt);
      } else {
        groups.set(batchId, {
          batchId,
          label: String(ctx.batchLabel ?? batchId),
          templateId: l.templateId,
          templateName: l.template.name,
          count: 1,
          redeemed,
          active,
          createdAt: l.createdAt.toISOString(),
          expiresAt: l.expiresAt.toISOString(),
          _times: [l.createdAt],
        });
      }
    }

    const batches = Array.from(groups.values())
      .map(({ _times, ...rest }) => {
        void _times;
        return rest;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return { batches };
  });

  // ----- Get batch detail (all URLs) -----
  app.get('/:batchId', async (req, reply) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const launches = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        template: { select: { id: true, name: true } },
        instance: {
          select: { id: true, subdomain: true, status: true, lastSeenAt: true },
        },
      },
    });
    if (launches.length === 0) {
      reply.code(404);
      return { error: 'batch_not_found' };
    }
    const first = launches[0]!;
    const ctx = (first.context ?? {}) as Record<string, unknown>;
    return {
      batchId,
      label: String(ctx.batchLabel ?? batchId),
      templateId: first.templateId,
      templateName: first.template.name,
      createdAt: first.createdAt.toISOString(),
      expiresAt: first.expiresAt.toISOString(),
      seats: launches.map((l, i) => {
        const lctx = (l.context ?? {}) as Record<string, unknown>;
        return {
          launchId: l.id,
          seat: Number(lctx.seat ?? i + 1),
          displayName: l.userDisplayName ?? `Seat ${i + 1}`,
          redeemed: l.redeemedAt?.toISOString() ?? null,
          instance: l.instance,
        };
      }),
    };
  });

  // ----- Create batch (N launches at once) -----
  app.post('/', async (req, reply) => {
    const tenant = req.tenant!;
    const parsed = BatchLaunchRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: parsed.error.issues };
    }
    const body = parsed.data;

    if (body.seatNames && body.seatNames.length !== body.count) {
      reply.code(400);
      return {
        error: 'seat_names_count_mismatch',
        detail: `seatNames length=${body.seatNames.length} count=${body.count}`,
      };
    }

    const template = await prisma.labTemplate.findFirst({
      where: { id: body.templateId, tenantId: tenant.id },
    });
    if (!template) {
      reply.code(404);
      return { error: 'template_not_found' };
    }

    const batchId = `b_${nanoid(12)}`;
    const ttlSeconds = body.ttlHours * 3600;
    const durationMinutes = Math.min(
      body.durationMinutes,
      config.LAB_MAX_DURATION_MINUTES,
    );

    // Build N launches in parallel — each token has its own jti so they're
    // independently revocable.
    const seatIndices = Array.from({ length: body.count }, (_, i) => i + 1);
    const items: BatchLaunchItem[] = await Promise.all(
      seatIndices.map(async (seat) => {
        const launchId = nanoid(16);
        const jti = nanoid(24);
        const displayName =
          body.seatNames?.[seat - 1] ?? `${body.label} #${String(seat).padStart(2, '0')}`;
        // Synthesise a per-seat user id. The lab is "anonymous-by-URL":
        // whoever holds the URL is that seat.
        const seatUserId = `batch:${batchId}:${seat}`;
        const userIdHash = hashUserId(seatUserId);

        const { token, expiresAt } = await signLaunchToken(
          {
            sub: launchId,
            jti,
            tenantId: tenant.id,
            templateId: template.id,
            userIdHash,
          },
          { ttlSeconds },
        );

        await prisma.launch.create({
          data: {
            id: launchId,
            tenantId: tenant.id,
            templateId: template.id,
            userIdHash,
            userDisplayName: displayName,
            durationMinutes,
            returnUrl: body.returnUrl,
            webhookUrl: body.webhookUrl,
            context: {
              batchId,
              batchLabel: body.label,
              seat,
            },
            tokenJti: jti,
            expiresAt,
          },
        });

        const launchUrl = `${config.PUBLIC_API_URL}/launch/redeem?t=${encodeURIComponent(token)}`;
        return {
          launchId,
          seat,
          displayName,
          launchUrl,
          expiresAt: expiresAt.toISOString(),
        };
      }),
    );

    const expiresAt = items[0]?.expiresAt ?? new Date().toISOString();
    const resp: BatchLaunchResponse = {
      batchId,
      label: body.label,
      templateId: template.id,
      count: items.length,
      createdAt: new Date().toISOString(),
      expiresAt,
      launches: items,
    };
    return resp;
  });

  // ----- Revoke all unredeemed URLs in a batch -----
  app.delete('/:batchId', async (req) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const result = await prisma.launch.updateMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
        redeemedAt: null,
      },
      data: { tokenJti: null, expiresAt: new Date() },
    });
    return { revoked: result.count };
  });
};
