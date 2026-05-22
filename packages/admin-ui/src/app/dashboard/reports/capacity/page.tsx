import { apiFetch } from '@/lib/api';
import { ReportTabs } from '../_components';

type Capacity = {
  tenantId: string;
  generatedAt: string;
  byStatus: Array<{ status: string; count: number }>;
  runningCpu: number;
  runningMemMb: number;
  pausedDiskAllowanceMb: number;
  activeNow: number;
  pausedNow: number;
};

export default async function CapacityPage() {
  const res = await apiFetch<Capacity>('/api/v1/reports/capacity');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const c = res.data;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Reports — capacity</h1>
        <p className="text-sm text-ink-900/60">
          Snapshot of right-now resource usage on this tenant.
        </p>
      </header>
      <ReportTabs active="/dashboard/reports/capacity" />

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active labs" value={c.activeNow} />
        <Stat label="Paused labs" value={c.pausedNow} />
        <Stat label="Generated" value={new Date(c.generatedAt).toLocaleTimeString()} />
        <Stat label="Running vCPU" value={c.runningCpu} />
        <Stat label="Running memory (MB)" value={c.runningMemMb} />
        <Stat label="Paused disk allowance (MB)" value={c.pausedDiskAllowanceMb} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Instances by status</h2>
        <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
              <tr>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Count</th>
              </tr>
            </thead>
            <tbody>
              {c.byStatus.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-3 py-6 text-center text-ink-900/50">
                    No instances on record.
                  </td>
                </tr>
              ) : (
                c.byStatus.map((s) => (
                  <tr key={s.status} className="border-t border-ink-100">
                    <td className="px-3 py-2 font-mono text-xs">{s.status}</td>
                    <td className="px-3 py-2 text-right">{s.count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card">
      <div className="text-xs text-ink-900/60">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}
