import type { FastifyPluginAsync } from 'fastify';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { authenticateTenant } from '../auth/apiKey.js';
import { config } from '../config.js';
import { prisma } from '../db.js';

const execAsync = promisify(exec);

/**
 * Server / host health endpoints. Mounted at /api/v1/host.
 *
 * Reports system-wide metrics (the single VPS that hosts every tenant's
 * containers). Tenant-authenticated so any operator with a key can see
 * how loaded the box is — useful for "why is provisioning slow today"
 * triage and capacity planning.
 *
 * All numbers are best-effort snapshots, NOT a time-series. Charts on
 * the frontend should poll every 5–10s and keep a rolling window in
 * client state if a live graph is needed.
 */
export const hostRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateTenant);

  const docker = new Docker({ socketPath: config.DOCKER_HOST_SOCKET });

  /**
   * GET /api/v1/host/snapshot
   * One-shot host + docker snapshot. Designed to be polled by a dashboard.
   */
  app.get('/snapshot', async () => {
    const [cpu, mem, disk, dockerInfo, containers] = await Promise.all([
      readCpu(),
      readMemory(),
      readDisk('/'),
      docker.info().catch(() => null),
      sampleLabContainerStats(docker).catch(() => null),
    ]);

    const loadavg = os.loadavg(); // [1m, 5m, 15m] — Linux only; macOS returns same, Windows returns 0s.
    const cpuCount = os.cpus().length || 1;

    return {
      generatedAt: new Date().toISOString(),
      uptimeSec: Math.floor(os.uptime()),
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
      },
      cpu: {
        cores: cpuCount,
        loadavg: { '1m': loadavg[0], '5m': loadavg[1], '15m': loadavg[2] },
        // Convert 1m loadavg to a 0..100 utilisation proxy (clamped) so the
        // UI can render a gauge without knowing core counts.
        usagePercent: Math.min(100, Math.round((loadavg[0] / cpuCount) * 100)),
        sampledPercent: cpu?.percent ?? null,
      },
      memory: mem,
      disk,
      docker: dockerInfo
        ? {
            containers: dockerInfo.Containers,
            containersRunning: dockerInfo.ContainersRunning,
            containersPaused: dockerInfo.ContainersPaused,
            containersStopped: dockerInfo.ContainersStopped,
            images: dockerInfo.Images,
            serverVersion: dockerInfo.ServerVersion,
            kernelVersion: dockerInfo.KernelVersion,
            operatingSystem: dockerInfo.OperatingSystem,
            memTotalBytes: dockerInfo.MemTotal,
            nCPU: dockerInfo.NCPU,
          }
        : null,
      labContainers: containers,
    };
  });

  /**
   * GET /api/v1/host/containers
   * Per-container live stats for every lab container on this host (i.e.
   * the ones tagged with labforge.instance=). Useful for the
   * "noisiest neighbour" panel on the Host dashboard.
   *
   * NOTE: docker stats sampling is *expensive* (1s per container with
   * stream:false). Cap at 50 containers to keep response time bounded;
   * pick the most recently active.
   */
  app.get('/containers', async (req) => {
    const tenant = req.tenant!;
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), 50);

    const instances = await prisma.labInstance.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ['ready', 'idle', 'provisioning', 'paused'] },
        runtimeId: { not: null },
      },
      orderBy: { lastActivityAt: 'desc' },
      take: limit,
      select: {
        id: true,
        subdomain: true,
        runtimeId: true,
        status: true,
        templateId: true,
        userIdHash: true,
        lastActivityAt: true,
        createdAt: true,
        template: { select: { name: true } },
      },
    });

    const rows = await Promise.all(
      instances.map(async (inst) => {
        if (!inst.runtimeId) return null;
        try {
          const c = docker.getContainer(inst.runtimeId);
          const stats = await statsOneShot(c);
          const cpuPercent = computeCpuPercent(stats);
          const memUsage = stats.memory_stats.usage ?? 0;
          const memLimit = stats.memory_stats.limit ?? 0;
          return {
            instanceId: inst.id,
            subdomain: inst.subdomain,
            templateName: inst.template.name,
            status: inst.status,
            cpuPercent,
            memBytes: memUsage,
            memLimitBytes: memLimit,
            memPercent: memLimit ? Math.round((memUsage / memLimit) * 1000) / 10 : 0,
            networkRxBytes: sumNet(stats.networks, 'rx_bytes'),
            networkTxBytes: sumNet(stats.networks, 'tx_bytes'),
            lastActivityAt: inst.lastActivityAt?.toISOString() ?? null,
          };
        } catch {
          return null;
        }
      }),
    );

    return {
      generatedAt: new Date().toISOString(),
      rows: rows.filter((r): r is NonNullable<typeof r> => r !== null),
    };
  });
};

// ---------- helpers ----------

// dockerode's `stats({ stream: false })` returns a one-shot object but its
// type overload still claims ReadableStream — cast through unknown.
type ContainerStatsDoc = {
  cpu_stats: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats: { usage?: number; limit?: number };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
};

async function statsOneShot(
  c: ReturnType<Docker['getContainer']>,
): Promise<ContainerStatsDoc> {
  return (await c.stats({ stream: false })) as unknown as ContainerStatsDoc;
}

/**
 * Standard formula recommended by Docker: delta(container_cpu) /
 * delta(system_cpu) × online_cpus × 100. Falls back to 0 when prior
 * samples are missing (first stats call).
 */
function computeCpuPercent(stats: ContainerStatsDoc): number {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const online = cpu.online_cpus ?? cpu.cpu_usage?.percpu_usage?.length ?? 1;
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  return Math.round((cpuDelta / sysDelta) * online * 1000) / 10;
}

function sumNet(
  nets: ContainerStatsDoc['networks'],
  key: 'rx_bytes' | 'tx_bytes',
): number {
  if (!nets) return 0;
  return Object.values(nets).reduce<number>((s, n) => s + (n[key] ?? 0), 0);
}

async function readCpu(): Promise<{ percent: number } | null> {
  // /proc/stat sample → 200ms wait → second sample → compute idle delta.
  // Linux only; on other OSes return null and let the UI fall back to
  // loadavg.
  if (os.platform() !== 'linux') return null;
  try {
    const a = await readProcStat();
    await new Promise((r) => setTimeout(r, 200));
    const b = await readProcStat();
    if (!a || !b) return null;
    const idle = b.idle - a.idle;
    const total = b.total - a.total;
    if (total <= 0) return null;
    return { percent: Math.round((1 - idle / total) * 1000) / 10 };
  } catch {
    return null;
  }
}

async function readProcStat(): Promise<{ idle: number; total: number } | null> {
  try {
    const txt = await fs.readFile('/proc/stat', 'utf8');
    const line = txt.split('\n')[0]; // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((s, n) => s + n, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

async function readMemory(): Promise<{
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
}> {
  const total = os.totalmem();
  const free = os.freemem();
  let available = free;
  // Linux: prefer MemAvailable (accounts for reclaimable cache) over MemFree.
  if (os.platform() === 'linux') {
    try {
      const txt = await fs.readFile('/proc/meminfo', 'utf8');
      const m = txt.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (m) available = Number(m[1]) * 1024;
    } catch {
      /* ignore */
    }
  }
  const used = total - available;
  return {
    totalBytes: total,
    freeBytes: free,
    availableBytes: available,
    usedBytes: used,
    usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

async function readDisk(
  mount: string,
): Promise<{
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
} | null> {
  // `df -PB1` returns: Filesystem 1-blocks Used Available Capacity Mounted on
  // POSIX format is stable. Skip on Windows.
  if (os.platform() === 'win32') return null;
  try {
    const { stdout } = await execAsync(`df -PB1 ${mount}`, { timeout: 2000 });
    const lines = stdout.trim().split('\n');
    const cols = lines[lines.length - 1].split(/\s+/);
    // [fs, total, used, avail, capacity, mount]
    const total = Number(cols[1]);
    const used = Number(cols[2]);
    const avail = Number(cols[3]);
    if (!Number.isFinite(total) || total === 0) return null;
    return {
      mount,
      totalBytes: total,
      usedBytes: used,
      availableBytes: avail,
      usedPercent: Math.round((used / total) * 1000) / 10,
    };
  } catch {
    return null;
  }
}

/**
 * Aggregate stats across every labforge.* container. Uses a single
 * lightweight `docker ps`-style listing rather than per-container stats
 * (too slow). The per-container drilldown lives in GET /containers.
 */
async function sampleLabContainerStats(docker: Docker): Promise<{
  total: number;
  running: number;
  paused: number;
  exited: number;
} | null> {
  try {
    const list = await docker.listContainers({
      all: true,
      filters: { label: ['labforge.instance'] },
    });
    let running = 0;
    let paused = 0;
    let exited = 0;
    for (const c of list) {
      if (c.State === 'running') running += 1;
      else if (c.State === 'paused') paused += 1;
      else if (c.State === 'exited' || c.State === 'dead') exited += 1;
    }
    return { total: list.length, running, paused, exited };
  } catch {
    return null;
  }
}
