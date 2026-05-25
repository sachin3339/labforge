import { apiFetch } from '@/lib/api';
import { ReportTabs, WindowPicker } from '../_components';
import { LineAreaChart, KpiTile } from '../_charts';

type Usage = {
  from: string;
  to: string;
  series: Array<{ day: string; launches: number; redemptions: number }>;
  totals: { launches: number; redemptions: number };
};

function buildQs(sp: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', new Date(sp.from).toISOString());
  if (sp.to) qs.set('to', new Date(sp.to).toISOString());
  return qs.toString();
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const qs = buildQs(sp);
  const res = await apiFetch<Usage>(`/api/v1/reports/usage${qs ? `?${qs}` : ''}`);
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const u = res.data;
  const redemptionRate =
    u.totals.launches > 0
      ? Math.round((u.totals.redemptions / u.totals.launches) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="eyebrow">Analytics · Reports</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Usage</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600">
          Aggregated usage, cost, and student activity for your tenant.
        </p>
      </header>
      <ReportTabs active="/dashboard/reports/usage" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <WindowPicker from={sp.from} to={sp.to} />
        <div className="text-xs text-ink-900/50">
          Window:{' '}
          <span className="font-mono">
            {u.from.slice(0, 10)} → {u.to.slice(0, 10)}
          </span>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Launches issued" value={u.totals.launches.toLocaleString()} />
        <KpiTile label="Redemptions" value={u.totals.redemptions.toLocaleString()} tone="good" />
        <KpiTile label="Redemption rate" value={`${redemptionRate}%`} hint="Students who actually clicked their URL" />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Daily activity</h2>
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
          data={u.series.map((s) => ({
            label: s.day,
            value: s.launches,
            secondary: s.redemptions,
          }))}
        />
      </section>
    </div>
  );
}
