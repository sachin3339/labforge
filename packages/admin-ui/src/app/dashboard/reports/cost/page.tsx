import { apiFetch } from '@/lib/api';
import { ReportTabs, WindowPicker } from '../_components';

type Row = {
  templateId: string;
  templateName: string;
  hours: number;
  redemptions: number;
  cost: number;
  revenue: number;
  margin: number;
};

type CostReport = {
  from: string;
  to: string;
  rows: Row[];
  totals: { hours: number; redemptions: number; cost: number; revenue: number; margin: number };
};

function buildQs(sp: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', new Date(sp.from).toISOString());
  if (sp.to) qs.set('to', new Date(sp.to).toISOString());
  return qs.toString();
}

export default async function CostPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const qs = buildQs(sp);
  const res = await apiFetch<CostReport>(
    `/api/v1/reports/cost${qs ? `?${qs}` : ''}`,
  );
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const r = res.data;
  const marginPct =
    r.totals.revenue > 0 ? Math.round((r.totals.margin / r.totals.revenue) * 100) : 0;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="eyebrow">Analytics · Reports</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Cost &amp; margin</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600">
          Cost is computed from compute hours × per-template <em>costPerHourUsd</em>. Revenue
          is redemptions × <em>priceListUsd</em>. Set both on each template to see margin.
        </p>
      </header>
      <ReportTabs active="/dashboard/reports/cost" />
      <WindowPicker from={sp.from} to={sp.to} />

      <section className="grid gap-4 sm:grid-cols-4">
        <Stat label="Compute hours" value={r.totals.hours.toFixed(1)} />
        <Stat label="Cost" value={`$${r.totals.cost.toFixed(2)}`} />
        <Stat label="Revenue" value={`$${r.totals.revenue.toFixed(2)}`} />
        <Stat label="Margin" value={`$${r.totals.margin.toFixed(2)} (${marginPct}%)`} />
      </section>

      <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
            <tr>
              <th className="px-3 py-2">Template</th>
              <th className="px-3 py-2 text-right">Hours</th>
              <th className="px-3 py-2 text-right">Redemptions</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2 text-right">Revenue</th>
              <th className="px-3 py-2 text-right">Margin</th>
              <th className="px-3 py-2 text-right">Margin %</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-900/50">
                  No data in this window.
                </td>
              </tr>
            ) : (
              r.rows.map((row) => {
                const pct =
                  row.revenue > 0 ? Math.round((row.margin / row.revenue) * 100) : 0;
                return (
                  <tr key={row.templateId} className="border-t border-ink-100">
                    <td className="px-3 py-2">{row.templateName}</td>
                    <td className="px-3 py-2 text-right">{row.hours.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right">{row.redemptions}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      ${row.cost.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      ${row.revenue.toFixed(2)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        row.margin < 0 ? 'text-red-700' : 'text-green-700'
                      }`}
                    >
                      ${row.margin.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">{pct}%</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="text-xs text-ink-900/60">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}
