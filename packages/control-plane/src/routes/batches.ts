import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
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
import { destroyInstance } from '../orchestrator.js';
import { acquireInstance, resumeInstance } from '../orchestrator.js';

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
          select: {
            id: true,
            subdomain: true,
            status: true,
            lastSeenAt: true,
            node: { select: { id: true, name: true } },
          },
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
          revoked: l.tokenJti === null,
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

  // ----- Rename a batch (update batchLabel on every seat's context JSON) -----
  app.patch('/:batchId', async (req, reply) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const body = z
      .object({ label: z.string().trim().min(1).max(200) })
      .safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: body.error.issues };
    }
    const launches = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
      select: { id: true, context: true },
    });
    if (launches.length === 0) {
      reply.code(404);
      return { error: 'batch_not_found' };
    }
    // Prisma can't merge a JSON column in-place without a raw query, so we
    // rewrite each context object individually. Volume is small (one batch).
    await prisma.$transaction(
      launches.map((l) => {
        const ctx = (l.context ?? {}) as Record<string, unknown>;
        return prisma.launch.update({
          where: { id: l.id },
          data: { context: { ...ctx, batchLabel: body.data.label } },
        });
      }),
    );
    return { ok: true, batchId, label: body.data.label, updated: launches.length };
  });

  // ----- Purge a batch (terminate live instances + delete all launch rows) -----
  // Destructive: removes the batch from the UI entirely. Use /terminate if you
  // want to keep the seat history around for auditing.
  app.delete('/:batchId/purge', async (req, reply) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const launches = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
      include: { instance: { select: { id: true, status: true } } },
    });
    if (launches.length === 0) {
      reply.code(404);
      return { error: 'batch_not_found' };
    }

    let terminated = 0;
    for (const l of launches) {
      if (
        l.instance &&
        !['terminated', 'failed'].includes(l.instance.status)
      ) {
        try {
          await destroyInstance(l.instance.id);
          terminated += 1;
        } catch (err) {
          app.log.warn(
            { err: (err as Error).message, instanceId: l.instance.id },
            '[batches] purge: destroyInstance failed',
          );
        }
      }
    }
    const deleted = await prisma.launch.deleteMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
    });
    return { ok: true, terminated, deleted: deleted.count };
  });

  // ----- Terminate entire batch (kill all live instances + revoke URLs) -----
  app.post('/:batchId/terminate', async (req, reply) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const body = z
      .object({ deleteVolumes: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body' };
    }

    const launches = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
      include: { instance: { select: { id: true, status: true } } },
    });
    if (launches.length === 0) {
      reply.code(404);
      return { error: 'batch_not_found' };
    }

    // Best-effort: terminate every live instance, then revoke the URLs.
    let terminated = 0;
    for (const l of launches) {
      if (
        l.instance &&
        !['terminated', 'failed'].includes(l.instance.status)
      ) {
        try {
          await destroyInstance(l.instance.id, {
            deleteVolume: body.data.deleteVolumes,
          });
          terminated += 1;
        } catch {
          // swallow; status update inside destroyInstance still records intent
        }
      }
    }

    const revoked = await prisma.launch.updateMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
      data: { tokenJti: null, expiresAt: new Date() },
    });

    return { ok: true, terminated, revoked: revoked.count };
  });

  // ----- Extend a batch (bump expiresAt on all launches + live instances) -----
  app.post('/:batchId/extend', async (req, reply) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const body = z
      .object({ extendHours: z.number().int().positive().max(8760) })
      .safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: body.error.issues };
    }
    const launches = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
      include: { instance: { select: { id: true } } },
    });
    if (launches.length === 0) {
      reply.code(404);
      return { error: 'batch_not_found' };
    }
    const bumpMs = body.data.extendHours * 3600_000;

    // Note: this does NOT re-sign JWTs. A JWT past its `exp` will be rejected
    // on redemption regardless of DB. For long extensions past the original
    // 30-day token window, use `regenerate` per seat instead.
    await prisma.$transaction([
      ...launches.map((l) =>
        prisma.launch.update({
          where: { id: l.id },
          data: { expiresAt: new Date(l.expiresAt.getTime() + bumpMs) },
        }),
      ),
      ...launches
        .filter((l) => l.instance)
        .map((l) =>
          prisma.labInstance.update({
            where: { id: l.instance!.id },
            data: {
              expiresAt: {
                // Using a raw bump keeps each instance aligned with its own
                // launch's previous timeline.
                set: new Date(
                  (l.expiresAt.getTime() + bumpMs),
                ),
              },
            },
          }),
        ),
    ]);
    return { ok: true, extendedSeats: launches.length, extendHours: body.data.extendHours };
  });

  // ----- Add seats to an existing batch -----
  app.post('/:batchId/add-seats', async (req, reply) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const body = z
      .object({
        count: z.number().int().positive().max(500),
        seatNames: z.array(z.string()).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: body.error.issues };
    }
    if (body.data.seatNames && body.data.seatNames.length !== body.data.count) {
      reply.code(400);
      return { error: 'seat_names_count_mismatch' };
    }

    // Crib settings from the existing first launch so the new seats land
    // in the same template, with the same TTL window and durationMinutes.
    const existing = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
      },
      orderBy: { createdAt: 'asc' },
      include: { template: true },
    });
    if (existing.length === 0) {
      reply.code(404);
      return { error: 'batch_not_found' };
    }
    const first = existing[0]!;
    const template = first.template;
    const baseCtx = (first.context ?? {}) as Record<string, unknown>;
    const label = String(baseCtx.batchLabel ?? batchId);
    // TTL = whatever the original first seat was signed for, anchored to now.
    const ttlSeconds = Math.max(
      1,
      Math.floor((first.expiresAt.getTime() - first.createdAt.getTime()) / 1000),
    );
    const startingSeat = existing.length;

    const seatIndices = Array.from(
      { length: body.data.count },
      (_, i) => startingSeat + i + 1,
    );
    const items: BatchLaunchItem[] = await Promise.all(
      seatIndices.map(async (seat, idx) => {
        const launchId = nanoid(16);
        const jti = nanoid(24);
        const displayName =
          body.data.seatNames?.[idx] ?? `${label} #${String(seat).padStart(2, '0')}`;
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
            durationMinutes: first.durationMinutes,
            returnUrl: first.returnUrl,
            webhookUrl: first.webhookUrl,
            context: { batchId, batchLabel: label, seat },
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
    return { batchId, added: items.length, launches: items };
  });

  /**
   * POST /api/v1/batches/:batchId/prepare
   *
   * Bulk-warm every seat in a batch so that when students click their
   * URLs they hit a ready upstream instead of waiting on cold provision.
   * Body: { concurrency?: 1..20 } controls how many provisions run in
   * parallel (default 5). Returns counts only; per-seat status is in the
   * regular GET /batches/:batchId.
   *
   * Idempotent — seats that already have a live instance are skipped;
   * paused instances are resumed.
   */
  app.post('/:batchId/prepare', async (req, reply) => {
    const tenant = req.tenant!;
    const { batchId } = req.params as { batchId: string };
    const body = z
      .object({ concurrency: z.number().int().min(1).max(20).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: 'invalid_body', issues: body.error.issues };
    }
    const concurrency = body.data.concurrency ?? 5;

    const launches = await prisma.launch.findMany({
      where: {
        tenantId: tenant.id,
        context: { path: ['batchId'], equals: batchId },
        expiresAt: { gt: new Date() },
      },
      include: { template: true, instance: true },
    });
    if (launches.length === 0) {
      reply.code(404);
      return { error: 'batch_not_found' };
    }

    let prepared = 0;
    let resumed = 0;
    let skipped = 0;
    let failed = 0;

    // Bounded-concurrency worker pool — Promise.all on 50 launches would
    // hammer Docker. A small fixed pool keeps the host responsive.
    const queue = [...launches];
    async function worker() {
      while (queue.length) {
        const l = queue.shift();
        if (!l) return;
        try {
          if (l.instance && ['ready', 'idle', 'provisioning', 'pending'].includes(l.instance.status)) {
            skipped += 1;
            continue;
          }
          if (l.instance && l.instance.status === 'paused' && l.instance.runtimeId) {
            await resumeInstance(l.instance.id);
            resumed += 1;
            continue;
          }
          const inst = await acquireInstance({
            tenantId: l.tenantId,
            template: l.template,
            userIdHash: l.userIdHash,
            durationMinutes: l.durationMinutes,
            expiresAt: l.expiresAt,
          });
          await prisma.launch.update({
            where: { id: l.id },
            data: { instanceId: inst.id },
          });
          prepared += 1;
        } catch (err) {
          app.log.warn(
            { err: (err as Error).message, launchId: l.id },
            '[batches] prepare failed',
          );
          failed += 1;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, launches.length) }, () => worker()),
    );

    return { batchId, total: launches.length, prepared, resumed, skipped, failed };
  });
};
