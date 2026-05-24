import Docker from 'dockerode';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent as UndiciAgent } from 'undici';
import { config } from '../config.js';
import type {
  ExecRequest,
  ExecResult,
  LabRuntime,
  ProvisionRequest,
  ProvisionResult,
} from './types.js';

/**
 * undici Agent that skips TLS verification for upstream readiness probes.
 * Lab containers use self-signed certs (e.g. KasmVNC on :6901); we just
 * need to know the socket is accepting handshakes, not validate identity.
 */
const httpsInsecureDispatcher = new UndiciAgent({
  connect: { rejectUnauthorized: false },
});

/**
 * Per-node Docker runtime adapter. One instance per `Node` row — see
 * runtime/nodes.ts for the factory/cache.
 *
 * In multi-node deployments the control-plane host does NOT share the
 * remote node's labnet, so we cannot reach containers via internal docker
 * DNS. Instead we always publish the lab port to an ephemeral host port
 * on the node and store `{node.proxyHost}:{hostPort}` as the upstream.
 * The wildcard proxy then opens a TCP/TLS socket directly to that
 * host:port. `LAB_PUBLISH_PORTS` is therefore implicitly true for
 * non-local nodes; we keep the env flag for single-host dev convenience.
 *
 * Security notes:
 *   - Containers run on a dedicated user-defined bridge network (`labnet`),
 *     isolated from the host network.
 *   - Published ports bind to `node.bindIp` only (default 127.0.0.1 for
 *     local, but operators set this to a private/Tailscale IP on remote
 *     boxes so the lab isn't exposed on 0.0.0.0).
 *   - CPU/memory hard-capped via cgroup limits.
 *   - Read-only root FS where the image allows; `/tmp` mounted tmpfs.
 */
export interface DockerRuntimeOpts {
  /** Live dockerode client (local socket OR ssh-tunnelled). */
  docker: Docker;
  /** Address the control-plane proxy uses to reach this node. */
  proxyHost: string;
  /** Interface on the node that published ports bind to. */
  bindIp: string;
}

export class DockerRuntime implements LabRuntime {
  readonly name = 'docker' as const;
  private readonly docker: Docker;
  private readonly proxyHost: string;
  private readonly bindIp: string;

  constructor(opts?: DockerRuntimeOpts) {
    if (opts) {
      this.docker = opts.docker;
      this.proxyHost = opts.proxyHost;
      this.bindIp = opts.bindIp;
    } else {
      // Backwards-compatible no-arg ctor used by the legacy getRuntime()
      // singleton path (mock-runtime tests etc). Targets the local socket.
      this.docker = new Docker({ socketPath: config.DOCKER_HOST_SOCKET });
      this.proxyHost = '127.0.0.1';
      this.bindIp = '127.0.0.1';
    }
  }

  async provision(req: ProvisionRequest): Promise<ProvisionResult> {
    const { spec, subdomain, instanceId } = req;
    const name = `lab-${subdomain}`;

    // Privileged / device-passthrough templates are gated by the host's
    // explicit opt-in. Otherwise reject at provision time — better than
    // silently downgrading and confusing the lesson author.
    const wantsPrivileged =
      spec.privileged === true || (spec.devices?.length ?? 0) > 0;
    if (wantsPrivileged && !config.LAB_ALLOW_PRIVILEGED) {
      throw new Error(
        `template requires privileged mode / device passthrough but ` +
          `LAB_ALLOW_PRIVILEGED is off on this host. Set it to true on a ` +
          `node with /dev/kvm to run VM-kind labs.`,
      );
    }

    // Pull image if missing. Best-effort; ignore failure (image may already exist).
    await this.ensureImage(spec.image);

    // Ensure each named volume exists. Volumes survive container removal
    // so the student's data persists across suspend/resume/reprovision.
    const binds: string[] = [];
    for (const vol of req.volumes ?? []) {
      await this.ensureVolume(vol.name);
      binds.push(`${vol.name}:${vol.containerPath}`);
    }

    const env = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);

    // Build HostConfig.Devices for /dev/kvm and friends.
    const devices = (spec.devices ?? []).map((path) => ({
      PathOnHost: path,
      PathInContainer: path,
      CgroupPermissions: 'rwm',
    }));

    const container = await this.docker.createContainer({
      name,
      Image: spec.image,
      Env: env,
      Cmd: spec.command && spec.command.length ? spec.command : undefined,
      Labels: {
        'labforge.instance': instanceId,
        'labforge.subdomain': subdomain,
        ...req.labels,
      },
      ExposedPorts: { [`${spec.port}/tcp`]: {} },
      HostConfig: {
        NetworkMode: config.DOCKER_NETWORK,
        Memory: spec.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(spec.cpu * 1e9),
        Binds: binds.length ? binds : undefined,
        // For VM-kind labs we keep CapDrop:ALL and selectively add back via
        // capAdd in the template (e.g. NET_ADMIN). Privileged overrides this
        // entirely when explicitly requested.
        CapDrop: ['ALL'],
        CapAdd: spec.capAdd?.length ? spec.capAdd : undefined,
        Sysctls: spec.sysctls && Object.keys(spec.sysctls).length ? spec.sysctls : undefined,
        Tmpfs: spec.tmpfs && Object.keys(spec.tmpfs).length ? spec.tmpfs : undefined,
        ShmSize: spec.shmSizeMb ? spec.shmSizeMb * 1024 * 1024 : undefined,
        Devices: devices.length ? devices : undefined,
        Privileged: spec.privileged === true,
        SecurityOpt: ['no-new-privileges:true'],
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
        // Always publish the lab port. The wildcard proxy reaches us via
        // `<node.proxyHost>:<assigned-host-port>` — there is no shared
        // labnet across nodes. We bind to `node.bindIp` so operators can
        // restrict exposure to a private interface.
        PortBindings: {
          [`${spec.port}/tcp`]: [{ HostIp: this.bindIp, HostPort: '0' }],
        },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [config.DOCKER_NETWORK]: {
            Aliases: [subdomain],
          },
        },
      },
    });

    await container.start();

    // Inspect to find the host-assigned port. We always publish (see above),
    // so no info here means the engine misbehaved.
    const info = await container.inspect();
    const binding = info.NetworkSettings?.Ports?.[`${spec.port}/tcp`]?.[0];
    const hostPort = binding?.HostPort;
    if (!hostPort) {
      throw new Error(
        `lab container ${name} started but no host port binding was created`,
      );
    }
    return {
      runtimeId: container.id,
      upstream: `${this.proxyHost}:${hostPort}`,
      hostPort: Number(hostPort),
    };
  }

  async isReady(
    runtimeId: string,
    upstream: string,
    scheme: 'http' | 'https' = 'http',
  ): Promise<boolean> {
    try {
      const c = this.docker.getContainer(runtimeId);
      const info = await c.inspect();
      if (!info.State.Running) return false;

      // TCP probe via fetch is overkill for raw TCP — use a simple HTTP HEAD
      // against the upstream. The control plane shares the labnet so DNS
      // resolves. Use `scheme` (template-defined) so HTTPS-only upstreams
      // (KasmVNC on :6901) are probed correctly instead of being rejected
      // as "non-SSL connection disallowed" every second.
      const url = `${scheme}://${upstream}/`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      try {
        const init: RequestInit & { dispatcher?: unknown } = {
          method: 'HEAD',
          signal: ctrl.signal,
        };
        if (scheme === 'https') {
          // Lab upstreams use self-signed certs; skip verification.
          init.dispatcher = httpsInsecureDispatcher;
        }
        await fetch(url, init);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return false;
    }
  }

  async destroy(runtimeId: string): Promise<void> {
    try {
      const c = this.docker.getContainer(runtimeId);
      await c.remove({ force: true, v: true });
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode !== 404) throw err;
    }
  }

  /**
   * Graceful stop — SIGTERM, then SIGKILL after 30s. The container row
   * and its mounted named volumes stay in place so resume() can bring
   * the same student back to the exact same lab state.
   */
  async suspend(runtimeId: string): Promise<void> {
    try {
      await this.docker.getContainer(runtimeId).stop({ t: 30 });
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      // 304 = already stopped, 404 = gone — both acceptable.
      if (e.statusCode !== 304 && e.statusCode !== 404) throw err;
    }
  }

  async resume(runtimeId: string): Promise<void> {
    try {
      await this.docker.getContainer(runtimeId).start();
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      // 304 = already running.
      if (e.statusCode !== 304) throw err;
    }
  }

  async destroyVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove();
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode !== 404 && e.statusCode !== 409) throw err;
    }
  }

  /**
   * Tail the most recent log lines from a container. Returns a single
   * string with newlines preserved; truncated to the last `tail` lines.
   * Best-effort: returns '' if the container is gone or the logs API
   * stream behaves oddly.
   */
  async logs(runtimeId: string, opts?: { tail?: number }): Promise<string> {
    const tail = Math.min(Math.max(opts?.tail ?? 200, 1), 5_000);
    try {
      const c = this.docker.getContainer(runtimeId);
      const buf = (await c.logs({
        stdout: true,
        stderr: true,
        tail,
        follow: false,
        timestamps: false,
      })) as unknown as Buffer;
      // dockerode returns a multiplexed stream when TTY is off. Each frame
      // is an 8-byte header (stream type + 4 zero + 4-byte BE length)
      // followed by `length` bytes of payload. We just strip headers; the
      // payload is what the admin wants to read.
      return demuxDockerLogs(buf);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 404) return '';
      throw err;
    }
  }

  async restart(runtimeId: string): Promise<void> {
    try {
      // 30s grace period to let the workload flush. Matches our suspend timeout.
      await this.docker.getContainer(runtimeId).restart({ t: 30 });
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode !== 404) throw err;
    }
  }

  async exec(runtimeId: string, req: ExecRequest): Promise<ExecResult> {
    const c = this.docker.getContainer(runtimeId);
    const maxBytes = req.maxOutputBytes ?? 64 * 1024;
    const timeoutMs = req.timeoutMs ?? 30_000;

    const exec = await c.exec({
      Cmd: req.cmd,
      WorkingDir: req.workdir,
      Env: req.env
        ? Object.entries(req.env).map(([k, v]) => `${k}=${v}`)
        : undefined,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;

    const stdout = {
      write(chunk: Buffer): void {
        if (stdoutLen >= maxBytes) return;
        const room = maxBytes - stdoutLen;
        stdoutChunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        stdoutLen += Math.min(chunk.length, room);
      },
    };
    const stderr = {
      write(chunk: Buffer): void {
        if (stderrLen >= maxBytes) return;
        const room = maxBytes - stderrLen;
        stderrChunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        stderrLen += Math.min(chunk.length, room);
      },
    };
    this.docker.modem.demuxStream(stream, stdout as never, stderr as never);

    // Poll exec.inspect() to detect completion. The hijacked stream doesn't
    // reliably emit 'end' across dockerode/podman, so we drive completion
    // off the engine's own state.
    const deadline = Date.now() + timeoutMs;
    let exitCode: number | null = null;
    let timedOut = false;
    while (true) {
      const info = await exec.inspect();
      if (!info.Running) {
        exitCode = info.ExitCode ?? null;
        break;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
        break;
      }
      await sleep(150);
    }

    // Allow a tiny window for any tail bytes to flush after exit.
    await sleep(50);

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      timedOut,
    };
  }

  private async ensureVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).inspect();
      return;
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode !== 404) throw err;
    }
    try {
      await this.docker.createVolume({
        Name: name,
        Labels: { 'labforge.managed': 'true' },
      });
    } catch (err: unknown) {
      // 409 means another concurrent provision just created it — fine.
      const e = err as { statusCode?: number };
      if (e.statusCode !== 409) throw err;
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // not present — pull
    }

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      });
    });

    // Tiny grace period so subsequent inspect() succeeds on slow disks.
    await sleep(100);
  }
}

/**
 * Demux the docker logs multiplexed framing into a single utf-8 string.
 * Each frame: [stream(1)][zero(3)][lengthBE(4)][payload(length)].
 * If the buffer doesn't look multiplexed (e.g. TTY output), return as-is.
 */
function demuxDockerLogs(buf: Buffer): string {
  if (buf.length === 0) return '';
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const streamType = buf[i];
    // Valid stream types from docker are 0 (stdin), 1 (stdout), 2 (stderr).
    // Anything else means this isn't multiplexed — fall back to raw.
    if (streamType === undefined || streamType > 2) {
      return buf.toString('utf8');
    }
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break;
    out.push(buf.subarray(start, end));
    i = end;
  }
  return Buffer.concat(out).toString('utf8');
}
