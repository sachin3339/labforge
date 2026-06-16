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
 * image. The overlay file lands at `<dir>/data.qcow2` so the dockur
 * container's `/storage/data.qcow2` works after a bind mount of
 * `<dir>:/storage`.
 *
 * The `.qcow2` extension is load-bearing: dockur's `src/disk.sh`
 * (qemus/qemu base image) auto-detects `DISK_FMT` from the filename
 * extension and uses `qemu-img info` for qcow2 sizing. A `.img` file
 * is treated as raw, measured with `stat -c%s` (returns ~193 KB for
 * a fresh overlay), and then blindly `truncate`-d up to DISK_SIZE,
 * which obliterates the qcow2 header and produces "No bootable
 * option or device was found" at UEFI.
 *
 * Also seeds the per-instance dir with dockur's "install completed"
 * marker files (windows.ver, windows.base, windows.mac, windows.mode,
 * windows.boot) and the UEFI NVRAM/TPM state files
 * (windows_secure.{rom,tpm,vars}) by copying them out of the golden's
 * parent directory. Without this, dockur sees a "fresh" /storage and
 * runs the Windows installer again, wiping the overlay before boot.
 *
 * Idempotent: if the dir already exists with a data.qcow2, this is a
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
  const dataPath = `${overlayDir}/data.qcow2`;
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

/**
 * Wait until the dockur Windows VM at `host:port` is actually serving
 * RDP — not just TCP-accepting and not just X.224-replying. We do a
 * full RDP handshake up to the point where the server hands us a TLS
 * certificate, because in our smoke test we saw cases where:
 *
 *   - QEMU is up (TCP accept works)
 *   - Windows kernel is up enough to answer X.224 NEG_RSP with a
 *     selected protocol (HYBRID_EX), so a naive X.224 probe says OK
 *   - …but TermService hasn't actually finished initialising the TLS
 *     listener yet, so when guacd or any real client tries to upgrade
 *     to TLS the server resets the connection. Guacamole reports this
 *     as "Server refused connection (wrong security type?)".
 *
 * Receiving the first byte of the TLS ServerHello ("\\x16" = TLS
 * Handshake content type) is the cheapest test that proves the RDP
 * server's TLS stack is fully up. We don't bother completing CredSSP
 * here — that needs the lab credentials and is properly tested by
 * Guacamole on first connect.
 *
 * Probe runs on the node hosting the VM so it doesn't traverse the
 * public internet; for `local` nodes this is just the control-plane
 * host. Times out after `timeoutMs`; throws to fail the provision so
 * the LabInstance row goes to `failed` instead of stuck `ready`.
 */
export async function waitForRdpReady(
  node: Node | null,
  host: string,
  port: number,
  timeoutMs = 360_000,
): Promise<void> {
  // Heredoc-fed Python one-liner. We pick Python because it's on every
  // dockur-capable Ubuntu host we run, and it gives us per-attempt
  // timeouts + read deadlines without shelling out to nc/ncat which
  // varies across distros (BSD nc has no -w on Linux, etc.).
  const pyScript = `
import socket, ssl, sys, time
host=sys.argv[1]; port=int(sys.argv[2]); deadline=time.time()+${Math.floor(timeoutMs / 1000)}
# X.224 Connection Request asking for SSL or HYBRID. Server replies
# with NEG_RSP picking one. We then perform a real TLS handshake on
# the same socket using Python's ssl module \u2014 if that completes,
# the RDP TLS stack is fully wired up.
x224=bytes.fromhex("030000130ee00000000000010008000b000000")
ctx=ssl.create_default_context()
ctx.check_hostname=False
ctx.verify_mode=ssl.CERT_NONE
ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
last=""
while time.time()<deadline:
  s=None
  try:
    s=socket.create_connection((host,port),timeout=4)
    s.settimeout(4)
    s.sendall(x224)
    data=s.recv(64)
    if not data:
      last="x224-empty"
      s.close(); time.sleep(2); continue
    # Wrap socket in TLS \u2014 server has selected SSL/HYBRID at this
    # point, so it expects the client to start TLS now.
    tls=ctx.wrap_socket(s, server_hostname=host, do_handshake_on_connect=True)
    cert=tls.getpeercert(binary_form=True)
    tls.close()
    sys.stdout.write("ok x224="+str(len(data))+" cert="+str(len(cert) if cert else 0)+"\\n"); sys.exit(0)
  except Exception as e:
    last=str(e)[:120]
    try:
      if s is not None: s.close()
    except Exception:
      pass
  time.sleep(2)
sys.stderr.write("timeout last="+last+"\\n"); sys.exit(1)
`;
  // base64-encode so heredoc-special chars in the script don't break
  // the SSH wrapper / sh -c parsing.
  const b64 = Buffer.from(pyScript, 'utf8').toString('base64');
  const cmd = `echo ${shQuote(b64)} | base64 -d | python3 - ${shQuote(host)} ${String(port)}`;
  const started = Date.now();
  const res = await nodeExec(node, cmd);
  const elapsed = Math.round((Date.now() - started) / 1000);
  if (res.exitCode !== 0) {
    throw new Error(
      `RDP readiness probe ${host}:${port} failed after ${elapsed}s on node ` +
        `${node?.name ?? 'local'}: ${res.stderr.trim().slice(0, 300) || res.stdout.trim().slice(0, 300)}`,
    );
  }
}
