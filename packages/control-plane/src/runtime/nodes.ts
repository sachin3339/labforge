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
 *   2. template.defaultNodeId (if the template has been pinned)
 *   3. the Node row flagged isDefault=true
 *   4. the only enabled node (when exactly one exists — single-box happy path)
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
      select: { defaultNodeId: true },
    }),
  ]);

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
