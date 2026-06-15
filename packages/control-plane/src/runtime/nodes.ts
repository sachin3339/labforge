import Docker from 'dockerode';
import { readFile } from 'node:fs/promises';
import type { Node } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { DockerRuntime } from './docker.js';
import { getRuntime as getDefaultRuntime } from './index.js';
import type { LabRuntime } from './types.js';

/**
 * Multi-node runtime resolution.
 *
 * Each `Node` row in Postgres describes one physical Docker host. This
 * module is the single source of truth that turns a `Node` (or null →
 * "default node") into a live `LabRuntime` the orchestrator can call.
 *
 * Why per-node clients?
 *   dockerode is essentially a thin HTTP-over-socket wrapper. The cheapest
 *   way to address N hosts is N dockerode instances, each pointing at a
 *   different transport (local unix socket, SSH stream, or TLS:2376). We
 *   cache them by Node.id so we don't re-open a fresh SSH channel for every
 *   container op.
 *
 * Backward compatibility:
 *   When RUNTIME != 'docker' (e.g. the unit-test 'mock' runtime) we ignore
 *   the node entirely and return the legacy singleton from `index.ts`. That
 *   keeps existing tests working.
 */

const runtimeCache = new Map<string, LabRuntime>();
// SSH keys are read from disk once per process and shared by every container
// op against that node. Re-reading on every provision adds 5ms of pointless
// syscall cost.
const sshKeyCache = new Map<string, Buffer>();

const LOCAL_KEY = '__local__';

/**
 * Resolve a `LabRuntime` for the given node. Pass `null` (or omit) for
 * "the local control-plane host" — handy for legacy code paths that don't
 * carry a node reference yet (prewarm pool background sweepers etc.).
 */
export async function getNodeRuntime(node: Node | null): Promise<LabRuntime> {
  if (config.RUNTIME !== 'docker') return getDefaultRuntime();

  const key = node?.id ?? LOCAL_KEY;
  const cached = runtimeCache.get(key);
  if (cached) return cached;

  const docker = await buildDockerClient(node);
  const proxyHost = node?.proxyHost ?? '127.0.0.1';
  const bindIp = node?.bindIp ?? '127.0.0.1';
  const rt = new DockerRuntime({ docker, proxyHost, bindIp });
  runtimeCache.set(key, rt);
  return rt;
}

/**
 * Quickly try to connect to a node and ping the Docker daemon. Used by the
 * admin "Test connection" button so operators can confirm a freshly added
 * node is reachable before they pin a template to it.
 */
export async function pingNode(
  node: Pick<Node, 'connectionMode' | 'sshHost' | 'sshUser' | 'sshPort' | 'sshKeyPath'>,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const docker = await buildDockerClient(node as Node);
    const v = await docker.version();
    return { ok: true, version: `${v.Version} (api ${v.ApiVersion})` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Invalidate the cached client for a node — call this whenever the admin
 * edits the node's connection settings so the next op picks up the new
 * SSH key / host / etc.
 */
export function invalidateNodeRuntime(nodeId: string): void {
  runtimeCache.delete(nodeId);
}

async function buildDockerClient(node: Node | null): Promise<Docker> {
  // No node row OR node explicitly marked local → talk to the local docker
  // socket. This is the only safe behaviour for single-node deployments.
  if (!node || node.connectionMode === 'local') {
    return new Docker({ socketPath: config.DOCKER_HOST_SOCKET });
  }

  if (node.connectionMode === 'ssh') {
    if (!node.sshHost || !node.sshKeyPath) {
      throw new Error(
        `node ${node.name} is connectionMode=ssh but is missing sshHost or sshKeyPath`,
      );
    }
    let key = sshKeyCache.get(node.sshKeyPath);
    if (!key) {
      key = await readFile(node.sshKeyPath);
      sshKeyCache.set(node.sshKeyPath, key);
    }
    // dockerode + ssh2: the underlying ssh2 client opens a streamlocal-
    // forward channel to /var/run/docker.sock on the remote host and pipes
    // Docker API requests through it. We get TLS-equivalent confidentiality
    // for free without provisioning per-node certs.
    return new Docker({
      protocol: 'ssh',
      host: node.sshHost,
      port: node.sshPort ?? 22,
      username: node.sshUser ?? 'ubuntu',
      sshOptions: {
        privateKey: key,
        // Strict host key checking is on by default in ssh2; for now we
        // accept any host key. Operators concerned about MITM should pin
        // a hostHash via `hostVerifier` later.
      },
    } as ConstructorParameters<typeof Docker>[0]);
  }

  throw new Error(`unsupported connectionMode '${node.connectionMode}' for node ${node.name}`);
}

/**
 * Resolve the node a fresh instance should land on. Resolution order:
 *   1. tenant.defaultNodeId (if the tenant has been pinned)
 *   2. template.defaultNodeId (if the template has been pinned to a single node)
 *   3. config.LAB_SCHEDULER='spread' → least-loaded healthy enabled node,
 *      restricted to template.allowedNodeIds when that list is non-empty
 *   4. the Node row flagged isDefault=true
 *   5. the only enabled node (when exactly one exists — single-box happy path)
 *
 * Returns null when no nodes exist at all (very-first-boot before the seed
 * has run) — orchestrator falls back to the implicit local docker socket
 * in that case so we don't break a fresh dev install.
 */
export async function resolveNodeForProvision(
  tenantId: string,
  templateId: string,
): Promise<Node | null> {
  const [tenant, template] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultNodeId: true } }),
    prisma.labTemplate.findUnique({
      where: { id: templateId },
      select: { defaultNodeId: true, allowedNodeIds: true },
    }),
  ]);

  // 1+2 — explicit single-node pin (tenant first, template second). A pin
  // always wins over the round-robin pool, even if the pinned node isn't
  // in `allowedNodeIds` (an explicit pin is the operator's override).
  const candidateId = tenant?.defaultNodeId ?? template?.defaultNodeId;
  if (candidateId) {
    const pinned = await prisma.node.findUnique({ where: { id: candidateId } });
    // A disabled pinned node is a configuration error worth surfacing —
    // don't silently fall back, the operator pinned it for a reason.
    if (pinned && !pinned.enabled) {
      throw new Error(
        `pinned node '${pinned.name}' is disabled; enable it or re-pin to another node`,
      );
    }
    if (pinned) return pinned;
  }

  // 3 — round-robin within the template's allowed-nodes pool. Empty list
  // means "no restriction" (legacy single-tier fleet behaviour).
  const allowed = (template?.allowedNodeIds ?? []).filter((id) => id.length > 0);
  if (config.LAB_SCHEDULER === 'spread') {
    const spread = await pickLeastLoadedNode(allowed.length > 0 ? allowed : undefined);
    if (spread) return spread;
    // If `allowedNodeIds` is set and we couldn't find a healthy member,
    // fall through to the cluster default. We deliberately do NOT widen
    // the search to nodes outside the whitelist — a Windows-only template
    // landing on a Linux box would just fail to provision noisily.
    if (allowed.length > 0) {
      throw new Error(
        `no healthy node available from template's allowed pool (${allowed.length} configured)`,
      );
    }
  }

  const def = await prisma.node.findFirst({
    where: { enabled: true, isDefault: true },
  });
  if (def) return def;

  // If only one enabled node exists, treat it as the implicit default —
  // saves operators from having to click "set default" on a fresh install.
  const enabled = await prisma.node.findMany({
    where: { enabled: true },
    take: 2,
  });
  if (enabled.length === 1) return enabled[0]!;

  // No nodes configured at all. Orchestrator handles this by using the local
  // docker socket directly (legacy single-host fallback).
  return null;
}

/**
 * Pick the next enabled+healthy node using strict round-robin. "Healthy"
 * means a successful ping within the last `NODE_HEALTH_STALE_SECONDS`, OR
 * lastSeenAt=null (allow brand-new nodes to receive work before the first
 * poll completes — otherwise a fresh fleet would have nowhere to land).
 *
 * Round-robin uses a process-local counter so it is immune to DB races
 * during concurrent provisions (e.g. /batches/:id/prepare with
 * concurrency=5 firing five picks within milliseconds). Counter survives
 * across reconnects/heath polls; it only resets on a control-plane
 * restart, which is acceptable because the resulting tiny first-launch
 * bias self-corrects after a few provisions.
 *
 * `capacityMax` is still honoured — saturated nodes are skipped and the
 * counter rolls forward to the next eligible candidate.
 *
 * `whitelist` (optional) restricts the candidate pool to nodes whose ids
 * appear in the list. Used by templates that pin themselves to a subset
 * of the fleet (e.g. Windows-only templates → Windows hosts). When omitted
 * or empty, all enabled+healthy nodes are eligible.
 */
let rrCursor = 0;
// Track a separate cursor per whitelist key so a Windows-template
// round-robin does not skew the next Ubuntu-template pick (and vice versa).
// The map is unbounded but keys are deterministic strings sorted+joined,
// so the cardinality is bounded by the number of distinct allowed-node
// configurations, which in practice is small (typically <= 5).
const rrCursorsByPool = new Map<string, number>();

async function pickLeastLoadedNode(whitelist?: string[]): Promise<Node | null> {
  const staleSeconds = config.NODE_HEALTH_STALE_SECONDS;
  const cutoff = new Date(Date.now() - staleSeconds * 1000);
  const candidates = await prisma.node.findMany({
    where: {
      enabled: true,
      OR: [{ lastSeenAt: null }, { lastSeenAt: { gte: cutoff } }],
      ...(whitelist && whitelist.length > 0 ? { id: { in: whitelist } } : {}),
    },
    orderBy: { name: 'asc' },
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const only = candidates[0]!;
    if (only.capacityMax > 0) {
      const load = await prisma.labInstance.count({
        where: { nodeId: only.id, status: { notIn: ['terminated', 'failed'] } },
      });
      if (load >= only.capacityMax) return null;
    }
    return only;
  }

  // Only fetch load counts if at least one node has a cap configured —
  // round-robin alone handles uncapped fleets and avoids an extra query
  // on the hot path.
  const anyCapped = candidates.some((n) => n.capacityMax > 0);
  const loadMap = new Map<string, number>();
  if (anyCapped) {
    const counts = await prisma.labInstance.groupBy({
      by: ['nodeId'],
      where: {
        nodeId: { in: candidates.map((n) => n.id) },
        status: { notIn: ['terminated', 'failed'] },
      },
      _count: { _all: true },
    });
    for (const row of counts) {
      if (row.nodeId) loadMap.set(row.nodeId, row._count._all);
    }
  }

  // Pick the right round-robin cursor for this pool. The fleet-wide pool
  // (no whitelist) keeps the legacy single-counter behaviour for back-compat
  // with existing tests; pinned pools each get their own cursor.
  const poolKey =
    whitelist && whitelist.length > 0 ? [...whitelist].sort().join(',') : '__all__';
  let cursor = poolKey === '__all__' ? rrCursor : (rrCursorsByPool.get(poolKey) ?? 0);

  // Walk the ring starting at cursor; skip nodes at capacity. Bail out
  // after one full lap to avoid infinite loop when every node is full.
  for (let i = 0; i < candidates.length; i += 1) {
    const idx = (cursor + i) % candidates.length;
    const cand = candidates[idx]!;
    const load = loadMap.get(cand.id) ?? 0;
    if (cand.capacityMax > 0 && load >= cand.capacityMax) continue;
    const next = (idx + 1) % candidates.length;
    if (poolKey === '__all__') rrCursor = next;
    else rrCursorsByPool.set(poolKey, next);
    return cand;
  }
  // Every healthy node is at capacity; let caller drop to isDefault path.
  return null;
}
