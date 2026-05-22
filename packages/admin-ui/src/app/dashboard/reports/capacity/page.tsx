import { apiFetch } from '@/lib/api';
import { ReportTabs } from '../_components';
import { Donut, KpiTile } from '../_charts';

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

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CapacityPage() {
  const res = await apiFetch<Capacity>('/api/v1/reports/capacity');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const c = res.data;

  const live = c.byStatus
    .filter((s) =>
      ['ready', 'idle', 'provisioning', 'pending', 'paused'].includes(s.status),
    )
    .reduce((acc, s) => acc + s.count, 0);

  const segments = c.byStatus
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
          <h1 className="text-2xl font-semibold tracking-tight">Capacity</h1>
          <p className="text-sm text-ink-900/60">
            Right-now resource reservations on this tenant.
          </p>
        </div>
        <div className="text-[10px] text-ink-900/40">
          sampled {new Date(c.generatedAt).toLocaleTimeString()}
        </div>
      </header>
      <ReportTabs active="/dashboard/reports/capacity" />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Active labs" value={c.activeNow} tone="good" />
        <KpiTile label="Paused labs" value={c.pausedNow} hint="Holding disk, free CPU/RAM" />
        <KpiTile label="Reserved vCPU" value={c.runningCpu.toFixed(2)} hint="Σ template.cpu across active" />
        <KpiTile
          label="Reserved memory"
          value={`${(c.runningMemMb / 1024).toFixed(1)} GB`}
          hint={`${c.runningMemMb.toLocaleString()} MB across active labs`}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold">Fleet status</h2>
          <div className="flex items-center justify-center">
            <Donut
              segments={segments}
              size={200}
              thickness={28}
              centerValue={live.toLocaleString()}
              centerLabel="live"
            />
          </div>
          <ul className="grid grid-cols-2 gap-1 text-[11px]">
            {c.byStatus.map((s) => (
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

        <div className="card lg:col-span-2 space-y-2">
          <h2 className="text-sm font-semibold">Counts by status</h2>
          <div className="overflow-hidden rounded-lg border border-ink-100">
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
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: STATUS_COLOR[s.status] ?? '#475569' }}
                          />
                          <span className="font-mono text-xs">{s.status}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-ink-900/40">
            Paused labs hold disk volumes but free CPU and RAM. Estimated paused-disk
            allowance:{' '}
            <span className="font-mono">{(c.pausedDiskAllowanceMb / 1024).toFixed(1)} GB</span>.
          </p>
        </div>
      </section>
    </div>
  );
}
