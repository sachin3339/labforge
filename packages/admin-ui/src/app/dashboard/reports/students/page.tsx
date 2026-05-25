import { apiFetch } from '@/lib/api';
import { ReportTabs, WindowPicker } from '../_components';

type Row = {
  userIdHash: string;
  sessions: number;
  redeemed: number;
  hours: number;
  templates: string[];
  lastActivityAt: string | null;
};

function buildQs(sp: { from?: string; to?: string; batchId?: string }) {
  const qs = new URLSearchParams();
  if (sp.from) qs.set('from', new Date(sp.from).toISOString());
  if (sp.to) qs.set('to', new Date(sp.to).toISOString());
  if (sp.batchId) qs.set('batchId', sp.batchId);
  return qs.toString();
}

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; batchId?: string }>;
}) {
  const sp = await searchParams;
  const qs = buildQs(sp);
  const res = await apiFetch<{ from: string; to: string; rows: Row[] }>(
    `/api/v1/reports/students${qs ? `?${qs}` : ''}`,
  );
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const rows = res.data.rows;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="eyebrow">Analytics · Reports</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Students</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600">
          One row per unique student (identified by hashed user id). Optionally
          filter to a single batch.
        </p>
      </header>
      <ReportTabs active="/dashboard/reports/students" />

      <form className="flex flex-wrap items-end gap-3 text-xs">
        <WindowPicker from={sp.from} to={sp.to} />
        <label className="flex flex-col text-ink-900/70">
          Batch ID (optional)
          <input
            name="batchId"
            defaultValue={sp.batchId ?? ''}
            className="mt-1 w-48 rounded border border-ink-200 px-2 py-1 font-mono text-xs"
          />
        </label>
      </form>

      <div className="text-xs text-ink-900/50">
        {rows.length} student{rows.length === 1 ? '' : 's'} active in window
      </div>

      <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
            <tr>
              <th className="px-3 py-2">Student (hash)</th>
              <th className="px-3 py-2 text-right">Sessions</th>
              <th className="px-3 py-2 text-right">Redeemed</th>
              <th className="px-3 py-2 text-right">Hours</th>
              <th className="px-3 py-2">Templates</th>
              <th className="px-3 py-2">Last active</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-ink-900/50">
                  No students with activity in this window.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.userIdHash} className="border-t border-ink-100">
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.userIdHash.slice(0, 16)}…
                  </td>
                  <td className="px-3 py-2 text-right">{r.sessions}</td>
                  <td className="px-3 py-2 text-right">{r.redeemed}</td>
                  <td className="px-3 py-2 text-right">{r.hours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-xs">{r.templates.join(', ')}</td>
                  <td className="px-3 py-2 text-xs text-ink-900/60">
                    {r.lastActivityAt
                      ? new Date(r.lastActivityAt).toLocaleString()
                      : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
