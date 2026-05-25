import { apiFetch } from '@/lib/api';
import { ReportTabs } from '../_components';
import { Gauge, KpiTile, fmtBytes, fmtDuration } from '../_charts';

type HostSnapshot = {
  generatedAt: string;
  uptimeSec: number;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    nodeVersion: string;
  };
  cpu: {
    cores: number;
    loadavg: { '1m': number; '5m': number; '15m': number };
    usagePercent: number;
    sampledPercent: number | null;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    availableBytes: number;
    usedBytes: number;
    usedPercent: number;
  };
  disk: {
    mount: string;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  } | null;
  docker: {
    containers: number;
    containersRunning: number;
    containersPaused: number;
    containersStopped: number;
    images: number;
    serverVersion: string;
    kernelVersion: string;
    operatingSystem: string;
    memTotalBytes: number;
    nCPU: number;
  } | null;
  labContainers: {
    total: number;
    running: number;
    paused: number;
    exited: number;
  } | null;
};

type Containers = {
  generatedAt: string;
  rows: Array<{
    instanceId: string;
    subdomain: string;
    templateName: string;
    status: string;
    cpuPercent: number;
    memBytes: number;
    memLimitBytes: number;
    memPercent: number;
    networkRxBytes: number;
    networkTxBytes: number;
    lastActivityAt: string | null;
  }>;
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HostHealthPage() {
  const [snapRes, contRes] = await Promise.all([
    apiFetch<HostSnapshot>('/api/v1/host/snapshot'),
    apiFetch<Containers>('/api/v1/host/containers?limit=20'),
  ]);
  if (!snapRes.ok) return <div className="text-red-600">Error: {snapRes.error}</div>;
  const h = snapRes.data;
  const c = contRes.ok ? contRes.data : null;

  const cpuPct = h.cpu.sampledPercent ?? h.cpu.usagePercent;
  const memPct = h.memory.usedPercent;
  const diskPct = h.disk?.usedPercent ?? 0;
  const load1 = h.cpu.loadavg['1m'];
  const loadCeil = h.cpu.cores;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="eyebrow">Analytics · Reports</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Host health</h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-600">
              Live system metrics for{' '}
              <span className="font-mono text-ink-800">{h.host.hostname}</span>{' '}
              · {h.host.platform}/{h.host.arch} · refresh the page for a fresh
              sample (Refresh every ~10s when watching).
            </p>
          </div>
        <div className="text-[10px] text-ink-900/40">
          sampled at {new Date(h.generatedAt).toLocaleTimeString()}
        </div>
      </header>
      <ReportTabs active="/dashboard/reports/host" />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card flex items-center gap-4">
          <Gauge percent={cpuPct} label="CPU" />
          <div className="text-xs text-ink-900/70 space-y-1">
            <div>
              <strong>{h.cpu.cores}</strong> logical cores
            </div>
            <div>
              load avg <span className="font-mono">{load1.toFixed(2)}</span> /{' '}
              {h.cpu.loadavg['5m'].toFixed(2)} /{' '}
              {h.cpu.loadavg['15m'].toFixed(2)}
            </div>
            <div className="text-[10px] text-ink-900/40">
              saturation when load &gt; {loadCeil}
            </div>
          </div>
        </div>

        <div className="card flex items-center gap-4">
          <Gauge percent={memPct} label="Memory" />
          <div className="text-xs text-ink-900/70 space-y-1">
            <div>
              <strong>{fmtBytes(h.memory.usedBytes)}</strong> /{' '}
              {fmtBytes(h.memory.totalBytes)}
            </div>
            <div className="text-ink-900/50">
              {fmtBytes(h.memory.availableBytes)} available
            </div>
            <div className="text-[10px] text-ink-900/40">
              available accounts for reclaimable cache
            </div>
          </div>
        </div>

        <div className="card flex items-center gap-4">
          <Gauge percent={diskPct} label={h.disk ? `Disk ${h.disk.mount}` : 'Disk'} />
          <div className="text-xs text-ink-900/70 space-y-1">
            {h.disk ? (
              <>
                <div>
                  <strong>{fmtBytes(h.disk.usedBytes)}</strong> /{' '}
                  {fmtBytes(h.disk.totalBytes)}
                </div>
                <div className="text-ink-900/50">
                  {fmtBytes(h.disk.availableBytes)} free
                </div>
                <div className="text-[10px] text-ink-900/40">
                  watch when used &gt; 85% — image pulls fail near 95%
                </div>
              </>
            ) : (
              <span className="text-ink-900/40">disk stats unavailable</span>
            )}
          </div>
        </div>

        <div className="card space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-ink-900/50">
            Uptime
          </div>
          <div className="text-3xl font-semibold tracking-tight">
            {fmtDuration(h.uptimeSec)}
          </div>
          <div className="text-[11px] text-ink-900/50">
            Node {h.host.nodeVersion}
          </div>
          {h.docker && (
            <div className="text-[11px] text-ink-900/50">
              Docker {h.docker.serverVersion} · {h.docker.nCPU} CPUs ·{' '}
              {fmtBytes(h.docker.memTotalBytes)}
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <KpiTile
          label="Total containers"
          value={h.docker?.containers ?? '—'}
          hint={`${h.docker?.containersRunning ?? 0} running · ${h.docker?.containersPaused ?? 0} paused · ${h.docker?.containersStopped ?? 0} stopped`}
        />
        <KpiTile
          label="Lab containers"
          value={h.labContainers?.total ?? '—'}
          hint={`${h.labContainers?.running ?? 0} running · ${h.labContainers?.paused ?? 0} paused · ${h.labContainers?.exited ?? 0} exited`}
          tone="good"
        />
        <KpiTile
          label="Images on disk"
          value={h.docker?.images ?? '—'}
          hint={h.docker?.operatingSystem ?? ''}
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Noisiest lab containers</h2>
          <div className="text-[10px] text-ink-900/40">
            live one-shot sample · {c?.rows.length ?? 0} containers
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
              <tr>
                <th className="px-3 py-2">Lab</th>
                <th className="px-3 py-2">Template</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">CPU %</th>
                <th className="px-3 py-2 text-right">Memory</th>
                <th className="px-3 py-2 text-right">Net rx</th>
                <th className="px-3 py-2 text-right">Net tx</th>
              </tr>
            </thead>
            <tbody>
              {!c || c.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-xs text-ink-900/40">
                    No live lab containers right now.
                  </td>
                </tr>
              ) : (
                [...c.rows]
                  .sort((a, b) => b.cpuPercent - a.cpuPercent)
                  .map((r) => (
                    <tr key={r.instanceId} className="border-t border-ink-100">
                      <td className="px-3 py-2 font-mono text-xs">{r.subdomain}</td>
                      <td className="px-3 py-2 text-xs">{r.templateName}</td>
                      <td className="px-3 py-2 text-xs text-ink-900/60">{r.status}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <UtilBar pct={r.cpuPercent} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">
                        <UtilBar pct={r.memPercent} />
                        <div className="text-[10px] text-ink-900/40">
                          {fmtBytes(r.memBytes)} / {fmtBytes(r.memLimitBytes)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">
                        {fmtBytes(r.networkRxBytes)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">
                        {fmtBytes(r.networkTxBytes)}
                      </td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {h.docker && (
        <section className="card text-xs text-ink-900/60 space-y-1">
          <h3 className="text-sm font-semibold text-ink-900">System info</h3>
          <div>Kernel: <span className="font-mono">{h.docker.kernelVersion}</span></div>
          <div>OS: <span className="font-mono">{h.docker.operatingSystem}</span></div>
          <div>
            Capacity ceiling: {h.docker.nCPU} CPU · {fmtBytes(h.docker.memTotalBytes)} RAM
          </div>
        </section>
      )}
    </div>
  );
}

function UtilBar({ pct }: { pct: number }) {
  const tone = pct < 60 ? 'bg-emerald-500' : pct < 85 ? 'bg-amber-500' : 'bg-red-500';
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="tabular-nums">{clamped.toFixed(1)}%</span>
      <div className="h-1.5 w-16 rounded-full bg-ink-50">
        <div
          className={`h-1.5 rounded-full ${tone}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
