import { apiFetch } from '@/lib/api';
import { ReportTabs, WindowPicker } from './_components';
import {
  LineAreaChart,
  KpiTile,
  Donut,
  HorizontalBars,
  fmtNum,
} from './_charts';

type Overview = {
  from: string;
  to: string;
  previous: { from: string; to: string };
  kpi: {
    launches: number;
    launchesDelta: number;
    redemptions: number;
    redemptionsDelta: number;
    redemptionRate: number;
    uniqueUsers: number;
    computeHours: number;
    redemptionEvents: number;
  };
  series: Array<{ day: string; launches: number; redemptions: number; uniqueUsers: number }>;
  statusBreakdown: Array<{ status: string; count: number }>;
  topTemplates: Array<{ templateId: string; templateName: string; launches: number }>;
};

const STATUS_COLOR: Record<string, string> = {
  ready: '#16a34a',
  idle: '#f59e0b',
  pending: '#3b82f6',
  provisioning: '#3b82f6',
  paused: '#a855f7',
  terminating: '#9ca3af',
  terminated: '#6b7280',
  failed: '#dc2626',
};

function buildQs(sp: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', new Date(sp.from).toISOString());
  if (sp.to) qs.set('to', new Date(sp.to).toISOString());
  return qs.toString();
}

export default async function ReportsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const qs = buildQs(sp);
  const res = await apiFetch<Overview>(`/api/v1/reports/overview${qs ? `?${qs}` : ''}`);
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const o = res.data;

  const live = o.statusBreakdown
    .filter((s) => ['ready', 'idle', 'provisioning', 'pending', 'paused'].includes(s.status))
    .reduce((acc, s) => acc + s.count, 0);

  const donutSegments = o.statusBreakdown
    .filter((s) => s.count > 0)
    .map((s) => ({
      label: s.status,
      value: s.count,
      color: STATUS_COLOR[s.status] ?? '#475569',
    }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-ink-900/60">
            Executive view of platform health, usage, and capacity.
          </p>
        </div>
        <div className="text-xs text-ink-900/50">
          Window:{' '}
          <span className="font-mono">
            {o.from.slice(0, 10)} → {o.to.slice(0, 10)}
          </span>
          <span className="ml-2">·</span>{' '}
          <span className="text-ink-900/40">
            vs {o.previous.from.slice(0, 10)} → {o.previous.to.slice(0, 10)}
          </span>
        </div>
      </header>
      <ReportTabs active="/dashboard/reports" />

      <WindowPicker from={sp.from} to={sp.to} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Launches issued"
          value={o.kpi.launches.toLocaleString()}
          delta={o.kpi.launchesDelta}
          hint="URLs minted in window"
        />
        <KpiTile
          label="Redemptions"
          value={o.kpi.redemptions.toLocaleString()}
          delta={o.kpi.redemptionsDelta}
          hint={`${o.kpi.redemptionRate}% redemption rate`}
          tone="good"
        />
        <KpiTile
          label="Compute hours"
          value={fmtNum(o.kpi.computeHours)}
          hint="Σ ready+resumed → paused/terminated"
        />
        <KpiTile
          label="Live labs now"
          value={live.toLocaleString()}
          tone={live > 0 ? 'good' : 'neutral'}
          hint={`${o.statusBreakdown.find((s) => s.status === 'paused')?.count ?? 0} paused`}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Activity over time</h2>
            <div className="flex items-center gap-3 text-[10px] text-ink-900/60">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 rounded-sm bg-brand" /> launches
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-3 rounded-sm bg-emerald-500" /> redemptions
              </span>
            </div>
          </div>
          <LineAreaChart
            height={260}
            primaryLabel="Launches"
            secondaryLabel="Redemptions"
            data={o.series.map((s) => ({
              label: s.day,
              value: s.launches,
              secondary: s.redemptions,
            }))}
          />
        </div>

        <div className="card space-y-3">
          <h2 className="text-sm font-semibold">Instance fleet</h2>
          <div className="flex items-center justify-center">
            <Donut
              segments={donutSegments}
              size={180}
              thickness={26}
              centerValue={live.toLocaleString()}
              centerLabel="live"
            />
          </div>
          <ul className="grid grid-cols-2 gap-1 text-[11px]">
            {o.statusBreakdown
              .filter((s) => s.count > 0)
              .map((s) => (
                <li key={s.status} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: STATUS_COLOR[s.status] ?? '#475569' }}
                  />
                  <span className="text-ink-900/70">{s.status}</span>
                  <span className="ml-auto tabular-nums text-ink-900/50">{s.count}</span>
                </li>
              ))}
          </ul>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold">Top templates by launches</h2>
          <HorizontalBars
            rows={o.topTemplates.map((t) => ({
              label: t.templateName,
              value: t.launches,
            }))}
          />
        </div>
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold">Quick links</h2>
          <ul className="space-y-1 text-sm">
            <li>
              <a href="/dashboard/reports/host" className="text-brand hover:underline">
                → Host health (CPU, memory, disk, Docker)
              </a>
            </li>
            <li>
              <a href="/dashboard/reports/pax-days" className="text-brand hover:underline">
                → Pax-days &amp; billing roll-up
              </a>
            </li>
            <li>
              <a href="/dashboard/reports/cost" className="text-brand hover:underline">
                → Cost / revenue / margin per template
              </a>
            </li>
            <li>
              <a href="/dashboard/reports/students" className="text-brand hover:underline">
                → Student-level activity
              </a>
            </li>
            <li>
              <a href="/dashboard/reports/capacity" className="text-brand hover:underline">
                → Right-now capacity snapshot
              </a>
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
