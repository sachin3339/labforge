/**
 * Worker-host shell-command helper for the orchestrator. Used for ops
 * that don't go through the Docker API: creating qcow2 overlays for VM
 * linked clones, deleting overlay directories on instance destroy, and
 * any one-off node-side filesystem work the runtime contract doesn't
 * cover.
 *
 * For local nodes we just shell out via `child_process`. For remote
 * SSH nodes we open a regular ssh2 client (separate from the dockerode
 * streamlocal channel) and exec a single command per call. The client
 * is cached per-node and recycled when invalidated.
 *
 * Treat every `nodeExec()` call as untrusted from the operator's view:
 * ALWAYS shell-quote arguments built from user/template input. The two
 * helpers `qemuImgCreateOverlay()` and `rmOverlayDir()` do this for the
 * known callers.
 */
import { Client as SshClient, type ConnectConfig } from 'ssh2';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { Node } from '@prisma/client';

const execAsync = promisify(execCb);

export interface NodeExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
}

interface CachedSsh {
  client: SshClient;
  ready: Promise<void>;
}

const sshCache = new Map<string, CachedSsh>();

/** Drop the cached SSH connection for a node — call after a node edit. */
export function invalidateNodeShell(nodeId: string): void {
  const cached = sshCache.get(nodeId);
  if (cached) {
    try {
      cached.client.end();
    } catch {
      // ignore
    }
    sshCache.delete(nodeId);
  }
}

async function buildSshConfig(node: Node): Promise<ConnectConfig> {
  if (!node.sshHost) {
    throw new Error(`node ${node.name}: sshHost is required for ssh shell`);
  }
  const cfg: ConnectConfig = {
    host: node.sshHost,
    port: node.sshPort ?? 22,
    username: node.sshUser ?? 'ubuntu',
    readyTimeout: 10_000,
    keepaliveInterval: 30_000,
  };
  if (node.sshKeyPath) {
    cfg.privateKey = await readFile(node.sshKeyPath);
  } else if (node.sshPassword) {
    cfg.password = node.sshPassword;
  } else {
    throw new Error(
      `node ${node.name}: nodeShell requires sshKeyPath or sshPassword`,
    );
  }
  return cfg;
}

async function getSshClient(node: Node): Promise<SshClient> {
  const cached = sshCache.get(node.id);
  if (cached) {
    await cached.ready;
    return cached.client;
  }
  const client = new SshClient();
  const ready = new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(err));
    // Drop the cache when the connection closes so a follow-up call
    // re-dials cleanly instead of blocking on a dead client.
    client.on('close', () => sshCache.delete(node.id));
  });
  sshCache.set(node.id, { client, ready });
  const cfg = await buildSshConfig(node);
  client.connect(cfg);
  await ready;
  return client;
}

async function execOverSsh(
  node: Node,
  cmd: string,
): Promise<NodeExecResult> {
  const client = await getSshClient(node);
  return new Promise<NodeExecResult>((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      stream.once('close', (exitCode: number | null, signal?: string) => {
        resolve({ exitCode, stdout, stderr, signal });
      });
      stream.once('error', (e: Error) => reject(e));
    });
  });
}

/**
 * Run a shell command on the worker node hosting `node`. Local nodes
 * (or null = control-plane host) shell out via child_process; SSH
 * nodes use a cached ssh2 client.
 */
export async function nodeExec(
  node: Node | null,
  cmd: string,
): Promise<NodeExecResult> {
  if (!node || node.connectionMode === 'local') {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        maxBuffer: 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === 'number' ? e.code : null,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? String(err),
      };
    }
  }
  if (node.connectionMode === 'ssh') {
    return execOverSsh(node, cmd);
  }
  throw new Error(
    `nodeExec: unsupported connectionMode '${node.connectionMode}' for node ${node.name}`,
  );
}

// Single-quote a string for safe interpolation into a /bin/sh -c command.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Create a per-instance qcow2 overlay backed by a read-only raw golden
 * image. The overlay file lands at `<dir>/data.img` so the dockur
 * container's expected `/storage/data.img` works after a bind mount of
 * `<dir>:/storage`.
 *
 * Also seeds the per-instance dir with dockur's "install completed"
 * marker files (windows.ver, windows.base, windows.mac, windows.mode)
 * and the UEFI NVRAM/TPM state files (windows_secure.{rom,tpm,vars})
 * by copying them out of the golden's parent directory. Without this,
 * dockur sees a "fresh" /storage and runs the Windows installer again,
 * wiping the overlay before boot.
 *
 * Idempotent: if the dir already exists with a data.img, this is a
 * no-op (qemu-img would refuse to overwrite, which is what we want
 * for resume-after-crash semantics). The marker copy is also
 * idempotent — files already present are not overwritten.
 */
export async function qemuImgCreateOverlay(
  node: Node | null,
  opts: {
    overlayDir: string;
    goldenImagePath: string;
    overlaySize: string;
  },
): Promise<void> {
  const { overlayDir, goldenImagePath, overlaySize } = opts;
  const dataPath = `${overlayDir}/data.img`;
  // dockur's marker + nvram files. Sourced from the golden's parent dir
  // (same place where the operator put `golden.img` after the bootstrap
  // builder finished). Per-instance copies — TPM/NVRAM state diverges
  // between instances at runtime, so each overlay needs its own.
  const seedFiles = [
    'windows.ver',
    'windows.base',
    'windows.mac',
    'windows.mode',
    'windows.boot',
    'windows_secure.rom',
    'windows_secure.tpm',
    'windows_secure.vars',
  ];
  const seedShellList = seedFiles.map((f) => shQuote(f)).join(' ');
  const cmd = [
    `mkdir -p ${shQuote(overlayDir)}`,
    `if [ ! -f ${shQuote(dataPath)} ]; then`,
    `  qemu-img create -f qcow2 -F raw -b ${shQuote(goldenImagePath)} -o backing_fmt=raw ${shQuote(dataPath)} ${shQuote(overlaySize)}`,
    `fi`,
    `goldenDir=$(dirname ${shQuote(goldenImagePath)})`,
    `for f in ${seedShellList}; do`,
    `  if [ -f "$goldenDir/$f" ] && [ ! -f ${shQuote(overlayDir)}/"$f" ]; then`,
    `    cp -- "$goldenDir/$f" ${shQuote(overlayDir)}/`,
    `  fi`,
    `done`,
    `true`,
  ].join('\n');
  const res = await nodeExec(node, cmd);
  if (res.exitCode !== 0) {
    throw new Error(
      `qemu-img create / seed failed on node ${node?.name ?? 'local'}: ` +
        `code=${res.exitCode} stderr=${res.stderr.trim().slice(0, 400)}`,
    );
  }
}

/** Remove an overlay directory recursively. Idempotent — missing dir is ok. */
export async function rmOverlayDir(
  node: Node | null,
  overlayDir: string,
): Promise<void> {
  // Defence-in-depth: refuse blindly recursive paths.
  if (
    !overlayDir ||
    !overlayDir.startsWith('/') ||
    overlayDir === '/' ||
    overlayDir.includes('..')
  ) {
    throw new Error(`rmOverlayDir: refusing unsafe path '${overlayDir}'`);
  }
  const res = await nodeExec(node, `rm -rf -- ${shQuote(overlayDir)}`);
  if (res.exitCode !== 0) {
    throw new Error(
      `rm -rf '${overlayDir}' failed on node ${node?.name ?? 'local'}: ` +
        `code=${res.exitCode} stderr=${res.stderr.trim().slice(0, 400)}`,
    );
  }
}
