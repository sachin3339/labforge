import { apiFetch } from '@/lib/api';
import { ReportTabs, WindowPicker } from '../_components';

type Row = {
  templateId: string;
  templateName: string;
  launches: number;
  redemptions: number;
  activeNow: number;
  costPerHourUsd?: number | null;
  priceListUsd?: number | null;
};

function buildQs(sp: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', new Date(sp.from).toISOString());
  if (sp.to) qs.set('to', new Date(sp.to).toISOString());
  return qs.toString();
}

export default async function TemplatesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const qs = buildQs(sp);
  const res = await apiFetch<{ from: string; to: string; rows: Row[] }>(
    `/api/v1/reports/templates${qs ? `?${qs}` : ''}`,
  );
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const rows = res.data.rows;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Reports — by template</h1>
        <p className="text-sm text-ink-900/60">
          Which lab environments are actually being used.
        </p>
      </header>
      <ReportTabs active="/dashboard/reports/templates" />
      <WindowPicker from={sp.from} to={sp.to} />

      <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
            <tr>
              <th className="px-3 py-2">Template</th>
              <th className="px-3 py-2 text-right">Launches</th>
              <th className="px-3 py-2 text-right">Redemptions</th>
              <th className="px-3 py-2 text-right">Conv. %</th>
              <th className="px-3 py-2 text-right">Active now</th>
              <th className="px-3 py-2 text-right">Cost/hr</th>
              <th className="px-3 py-2 text-right">List $</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-900/50">
                  No data in this window.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const conv =
                  r.launches > 0
                    ? Math.round((r.redemptions / r.launches) * 100)
                    : 0;
                return (
                  <tr key={r.templateId} className="border-t border-ink-100">
                    <td className="px-3 py-2">{r.templateName}</td>
                    <td className="px-3 py-2 text-right">{r.launches}</td>
                    <td className="px-3 py-2 text-right">{r.redemptions}</td>
                    <td className="px-3 py-2 text-right">{conv}%</td>
                    <td className="px-3 py-2 text-right">{r.activeNow}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.costPerHourUsd != null ? `$${r.costPerHourUsd.toFixed(3)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.priceListUsd != null ? `$${r.priceListUsd.toFixed(2)}` : '—'}
                    </td>
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
