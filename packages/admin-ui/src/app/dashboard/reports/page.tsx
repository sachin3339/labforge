import { apiFetch } from '@/lib/api';
import { ReportTabs, WindowPicker, BarChart } from './_components';

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
      <header>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-ink-900/60">
          Aggregated usage, cost, and student activity for your tenant.
        </p>
      </header>
      <ReportTabs active="/dashboard/reports" />

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
        <Stat label="Launches issued" value={u.totals.launches} />
        <Stat label="Redemptions" value={u.totals.redemptions} />
        <Stat label="Redemption rate" value={`${redemptionRate}%`} />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Daily activity</h2>
          <div className="flex items-center gap-3 text-[10px] text-ink-900/60">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 bg-brand" /> launches
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 bg-green-500" /> redemptions
            </span>
          </div>
        </div>
        <BarChart
          data={u.series.map((s) => ({
            label: s.day.slice(0, 10),
            value: s.launches,
            secondary: s.redemptions,
          }))}
        />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card">
      <div className="text-xs text-ink-900/60">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
