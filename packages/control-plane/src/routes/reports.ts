import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma, InstanceStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { authenticateTenant } from '../auth/apiKey.js';
import type { LabTemplateSpec as LabTemplateSpecT } from '@labforge/shared';

/**
 * Admin reports & dashboard data. Mounted under /api/v1/reports.
 *
 * All endpoints are tenant-scoped. Aggregation runs in Postgres where
 * possible (Prisma groupBy / raw SQL) and is bounded by an explicit
 * date window so historical growth never blows the response.
 */

const Window = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .transform((v) => {
    const to = v.to ? new Date(v.to) : new Date();
    const from = v.from
      ? new Date(v.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from, to };
  });

const ACTIVE_STATUSES: InstanceStatus[] = [
  InstanceStatus.pending,
  InstanceStatus.provisioning,
  InstanceStatus.ready,
  InstanceStatus.idle,
];
const LIVE_STATUSES: InstanceStatus[] = [...ACTIVE_STATUSES, InstanceStatus.paused];

/** Narrow Prisma's groupBy `_count` union so `._all` is always accessible. */
function countAll(c: unknown): number {
  if (c && typeof c === 'object' && '_all' in c) {
    const v = (c as { _all?: number })._all;
    return typeof v === 'number' ? v : 0;
  }
  return 0;
}

export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  /**
   * GET /api/v1/reports/usage?from=&to=
   * Per-day rollup of launches and redemptions across the window. Default
   * window is the last 30 days.
   */
  app.get('/usage', async (req, reply) => {
    const tenant = req.tenant!;
    const w = Window.safeParse(parseQuery(req.url));
    if (!w.success) {
      reply.code(400);
      return { error: 'invalid_window' };
    }
    const { from, to } = w.data;

    // One trip to Postgres: daily counts of launches + redemptions.
    // Using a single CTE-ish SELECT so we don't fan out across 30 queries.
    type Row = { day: Date; launches: bigint; redemptions: bigint };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT
        date_trunc('day', "createdAt") AS day,
        COUNT(*)::bigint                AS launches,
        COUNT("redeemedAt")::bigint     AS redemptions
      FROM "Launch"
      WHERE "tenantId" = ${tenant.id}
        AND "createdAt" >= ${from}
        AND "createdAt" <  ${to}
      GROUP BY day
      ORDER BY day ASC
    `;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      series: rows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        launches: Number(r.launches),
        redemptions: Number(r.redemptions),
      })),
      totals: {
        launches: rows.reduce((s, r) => s + Number(r.launches), 0),
        redemptions: rows.reduce((s, r) => s + Number(r.redemptions), 0),
      },
    };
  });

  /**
   * GET /api/v1/reports/templates?from=&to=
   * Per-template rollup: launches, redemptions, active-now counts.
   */
  app.get('/templates', async (req, reply) => {
    const tenant = req.tenant!;
    const w = Window.safeParse(parseQuery(req.url));
    if (!w.success) {
      reply.code(400);
      return { error: 'invalid_window' };
    }
    const { from, to } = w.data;

    const [launchAgg, redeemAgg, liveByTemplate, templates] = await Promise.all([
      prisma.launch.groupBy({
        by: ['templateId'],
        where: {
          tenantId: tenant.id,
          createdAt: { gte: from, lt: to },
        },
        _count: { _all: true },
      }),
      prisma.launch.groupBy({
        by: ['templateId'],
        where: {
          tenantId: tenant.id,
          createdAt: { gte: from, lt: to },
          redeemedAt: { not: null },
        },
        _count: { _all: true },
      }),
      prisma.labInstance.groupBy({
        by: ['templateId'],
        where: {
          tenantId: tenant.id,
          isPrewarm: false,
          status: { in: LIVE_STATUSES },
        },
        _count: { _all: true },
      }),
      prisma.labTemplate.findMany({
        where: { tenantId: tenant.id },
        select: { id: true, name: true, spec: true },
      }),
    ]);

    const launchMap = new Map(launchAgg.map((r) => [r.templateId, countAll(r._count)]));
    const redeemMap = new Map(redeemAgg.map((r) => [r.templateId, countAll(r._count)]));
    const liveMap = new Map(liveByTemplate.map((r) => [r.templateId, countAll(r._count)]));

    const rows = templates
      .map((t) => {
        const spec = t.spec as unknown as LabTemplateSpecT;
        return {
          templateId: t.id,
          templateName: t.name,
          launches: launchMap.get(t.id) ?? 0,
          redemptions: redeemMap.get(t.id) ?? 0,
          activeNow: liveMap.get(t.id) ?? 0,
          costPerHourUsd: spec.costPerHourUsd ?? null,
          priceListUsd: spec.priceListUsd ?? null,
        };
      })
      .sort((a, b) => b.redemptions - a.redemptions);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rows,
    };
  });

  /**
   * GET /api/v1/reports/cost?from=&to=
   * Cost + revenue + margin. Cost = Σ (template.costPerHourUsd × hoursAlive)
   * across every instance whose lifetime overlaps the window. Revenue =
   * Σ (template.priceListUsd) across redemptions in the window.
   *
   * Templates without pricing contribute 0 (the row still shows up with
   * hours, just no $$ figures).
   */
  app.get('/cost', async (req, reply) => {
    const tenant = req.tenant!;
    const w = Window.safeParse(parseQuery(req.url));
    if (!w.success) {
      reply.code(400);
      return { error: 'invalid_window' };
    }
    const { from, to } = w.data;
    const now = new Date();

    // Pull every instance touching the window. Cap to a sane upper bound;
    // tenants with > 100k instances in a window can paginate later.
    const instances = await prisma.labInstance.findMany({
      where: {
        tenantId: tenant.id,
        isPrewarm: false,
        OR: [
          { createdAt: { gte: from, lt: to } },
          { terminatedAt: { gte: from, lt: to } },
          // Long-running labs that span the entire window.
          {
            AND: [
              { createdAt: { lt: from } },
              {
                OR: [
                  { terminatedAt: null },
                  { terminatedAt: { gte: to } },
                ],
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        templateId: true,
        createdAt: true,
        terminatedAt: true,
        status: true,
      },
    });

    const redemptions = await prisma.launch.groupBy({
      by: ['templateId'],
      where: {
        tenantId: tenant.id,
        redeemedAt: { gte: from, lt: to },
      },
      _count: { _all: true },
    });
    const redeemMap = new Map(redemptions.map((r) => [r.templateId, countAll(r._count)]));

    const templates = await prisma.labTemplate.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, name: true, spec: true },
    });

    type Row = {
      templateId: string;
      templateName: string;
      hours: number;
      instances: number;
      redemptions: number;
      cost: number;
      revenue: number;
      margin: number;
    };
    const rowMap = new Map<string, Row>();
    for (const t of templates) {
      const spec = t.spec as unknown as LabTemplateSpecT;
      const redeems = redeemMap.get(t.id) ?? 0;
      rowMap.set(t.id, {
        templateId: t.id,
        templateName: t.name,
        hours: 0,
        instances: 0,
        redemptions: redeems,
        cost: 0,
        revenue: (spec.priceListUsd ?? 0) * redeems,
        margin: 0,
      });
    }

    for (const inst of instances) {
      const row = rowMap.get(inst.templateId);
      if (!row) continue;
      const t = templates.find((x) => x.id === inst.templateId)!;
      const spec = t.spec as unknown as LabTemplateSpecT;
      const startMs = Math.max(inst.createdAt.getTime(), from.getTime());
      const endMs = Math.min(
        (inst.terminatedAt ?? now).getTime(),
        to.getTime(),
      );
      const hours = Math.max(0, (endMs - startMs) / 3600_000);
      row.hours += hours;
      row.instances += 1;
      row.cost += hours * (spec.costPerHourUsd ?? 0);
    }
    for (const row of rowMap.values()) {
      row.margin = row.revenue - row.cost;
      row.hours = Math.round(row.hours * 100) / 100;
      row.cost = Math.round(row.cost * 100) / 100;
      row.revenue = Math.round(row.revenue * 100) / 100;
      row.margin = Math.round(row.margin * 100) / 100;
    }
    const rows = Array.from(rowMap.values()).sort((a, b) => b.cost - a.cost);
    const totals = rows.reduce(
      (s, r) => ({
        hours: s.hours + r.hours,
        instances: s.instances + r.instances,
        redemptions: s.redemptions + r.redemptions,
        cost: s.cost + r.cost,
        revenue: s.revenue + r.revenue,
        margin: s.margin + r.margin,
      }),
      { hours: 0, instances: 0, redemptions: 0, cost: 0, revenue: 0, margin: 0 },
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rows,
      totals: {
        ...totals,
        hours: Math.round(totals.hours * 100) / 100,
        cost: Math.round(totals.cost * 100) / 100,
        revenue: Math.round(totals.revenue * 100) / 100,
        margin: Math.round(totals.margin * 100) / 100,
      },
    };
  });

  /**
   * GET /api/v1/reports/students?from=&to=&batchId=
   * Per-student rollup: sessions, total active hours, last seen. A
   * "student" is identified by userIdHash; for batch launches this is the
   * synthesised `batch:<id>:<seat>` hash, so the display name comes from
   * the launch's userDisplayName.
   */
  app.get('/students', async (req, reply) => {
    const tenant = req.tenant!;
    const w = Window.safeParse(parseQuery(req.url));
    if (!w.success) {
      reply.code(400);
      return { error: 'invalid_window' };
    }
    const url = new URL(req.url, 'http://x');
    const batchId = url.searchParams.get('batchId');
    const { from, to } = w.data;

    const launchWhere: Prisma.LaunchWhereInput = {
      tenantId: tenant.id,
      createdAt: { gte: from, lt: to },
    };
    if (batchId) {
      launchWhere.context = { path: ['batchId'], equals: batchId };
    }

    const launches = await prisma.launch.findMany({
      where: launchWhere,
      include: {
        instance: {
          select: {
            createdAt: true,
            terminatedAt: true,
            lastActivityAt: true,
            status: true,
          },
        },
        template: { select: { id: true, name: true } },
      },
      take: 10_000,
    });

    type Row = {
      userIdHash: string;
      displayName: string;
      templates: Set<string>;
      sessions: number;
      redeemed: number;
      hours: number;
      lastActivityAt: Date | null;
    };
    const map = new Map<string, Row>();
    for (const l of launches) {
      let row = map.get(l.userIdHash);
      if (!row) {
        row = {
          userIdHash: l.userIdHash,
          displayName: l.userDisplayName ?? l.userIdHash.slice(0, 8),
          templates: new Set(),
          sessions: 0,
          redeemed: 0,
          hours: 0,
          lastActivityAt: null,
        };
        map.set(l.userIdHash, row);
      }
      row.sessions += 1;
      if (l.redeemedAt) row.redeemed += 1;
      row.templates.add(l.template.name);
      if (l.instance) {
        const start = l.instance.createdAt.getTime();
        const end = (l.instance.terminatedAt ?? new Date()).getTime();
        row.hours += Math.max(0, (end - start) / 3600_000);
        const la = l.instance.lastActivityAt;
        if (la && (!row.lastActivityAt || la > row.lastActivityAt)) {
          row.lastActivityAt = la;
        }
      }
    }

    const students = Array.from(map.values())
      .map((r) => ({
        userIdHash: r.userIdHash,
        displayName: r.displayName,
        templates: Array.from(r.templates),
        sessions: r.sessions,
        redeemed: r.redeemed,
        hours: Math.round(r.hours * 100) / 100,
        lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
      }))
      .sort((a, b) => b.hours - a.hours);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      batchId: batchId ?? null,
      rows: students,
    };
  });

  /**
   * GET /api/v1/reports/capacity
   * Snapshot of right-now state: counts by status, total compute reserved,
   * disk used by managed volumes. Powers the home dashboard.
   */
  app.get('/capacity', async (req) => {
    const tenant = req.tenant!;

    const [byStatus, all] = await Promise.all([
      prisma.labInstance.groupBy({
        by: ['status'],
        where: { tenantId: tenant.id, isPrewarm: false },
        _count: { _all: true },
      }),
      prisma.labInstance.findMany({
        where: {
          tenantId: tenant.id,
          isPrewarm: false,
          status: { in: LIVE_STATUSES },
        },
        select: { templateId: true, status: true },
      }),
    ]);

    const templates = await prisma.labTemplate.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, name: true, spec: true },
    });
    const tmplMap = new Map(templates.map((t) => [t.id, t]));

    let runningCpu = 0;
    let runningMemMb = 0;
    let pausedDiskAllowanceMb = 0;
    for (const inst of all) {
      const t = tmplMap.get(inst.templateId);
      if (!t) continue;
      const spec = t.spec as unknown as LabTemplateSpecT;
      if (ACTIVE_STATUSES.includes(inst.status)) {
        runningCpu += spec.cpu;
        runningMemMb += spec.memoryMb;
      } else if (inst.status === 'paused') {
        // Paused labs hold their disk but free CPU/RAM. Best-effort 32 GB
        // budget per Windows-class lab, 4 GB for others — used purely for
        // the dashboard's "disk in use by suspended labs" indicator.
        pausedDiskAllowanceMb += spec.runtime === 'vm' ? 32_768 : 4_096;
      }
    }

    return {
      tenantId: tenant.id,
      generatedAt: new Date().toISOString(),
      byStatus: byStatus.map((r) => ({ status: r.status, count: countAll(r._count) })),
      runningCpu,
      runningMemMb,
      pausedDiskAllowanceMb,
      activeNow: all.filter((i) => ACTIVE_STATUSES.includes(i.status)).length,
      pausedNow: all.filter((i) => i.status === 'paused').length,
    };
  });
};

function parseQuery(url: string): Record<string, string> {
  const u = new URL(url, 'http://x');
  return Object.fromEntries(u.searchParams.entries());
}
