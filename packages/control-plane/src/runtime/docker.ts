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

    // Ensure the shared lab bridge network exists on this node. Compose
    // creates it on the primary, but remote worker nodes are bare Docker
    // hosts — first provision on each node has to create it.
    await this.ensureNetwork(config.DOCKER_NETWORK);

    // Ensure each named volume exists. Volumes survive container removal
    // so the student's data persists across suspend/resume/reprovision.
    const binds: string[] = [];
    for (const vol of req.volumes ?? []) {
      await this.ensureVolume(vol.name);
      binds.push(`${vol.name}:${vol.containerPath}`);
    }
    // Direct host-path binds (linked-clone overlays etc). The
    // orchestrator is responsible for creating the host path before
    // calling provision; we don't create or own it here.
    for (const m of req.bindMounts ?? []) {
      const ro = m.readOnly ? ':ro' : '';
      binds.push(`${m.hostPath}:${m.containerPath}${ro}`);
    }

    const env = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);

    // VM runtimes (dockur/windows, dockur/macos, ...) run QEMU INSIDE the
    // container. `spec.memoryMb` maps to the guest RAM (RAM_SIZE env), but
    // the container's total RSS is guest RAM PLUS QEMU's own overhead —
    // framebuffer, OVMF/UEFI, TPM emulation, dirty-page tracking, host
    // page tables — which runs ~1–2 GiB for a desktop Windows guest.
    //
    // If the cgroup Memory limit equals the guest RAM (as it did), the
    // container exceeds its limit the moment the guest commits most of its
    // RAM and the cgroup OOM-killer terminates QEMU (State.OOMKilled=true,
    // exit 0 from the entrypoint's trap). Students see this as a random
    // BSOD / "VM crashed" / session-closed termination. Give VM containers
    // headroom above the guest RAM so QEMU has room to breathe.
    const isVmRuntime = spec.runtime === 'vm';
    const memoryOverheadMb = isVmRuntime
      ? Math.max(2048, Math.round(spec.memoryMb * 0.2))
      : 0;
    const memoryLimitBytes = (spec.memoryMb + memoryOverheadMb) * 1024 * 1024;

    // Build HostConfig.Devices for /dev/kvm and friends.
    const devices = (spec.devices ?? []).map((path) => ({
      PathOnHost: path,
      PathInContainer: path,
      CgroupPermissions: 'rwm',
    }));

    // ExposedPorts + PortBindings: always the primary `spec.port`, plus
    // any extras the caller asked for (e.g. RDP 3389 on Windows VMs).
    const exposedPorts: Record<string, object> = {
      [`${spec.port}/tcp`]: {},
    };
    const portBindings: Record<
      string,
      Array<{ HostIp: string; HostPort: string }>
    > = {
      [`${spec.port}/tcp`]: [{ HostIp: this.bindIp, HostPort: '0' }],
    };
    for (const cp of req.extraPortBindings ?? []) {
      if (cp === spec.port) continue; // already exposed
      const key = `${cp}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostIp: this.bindIp, HostPort: '0' }];
    }

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
      ExposedPorts: exposedPorts,
      HostConfig: {
        NetworkMode: config.DOCKER_NETWORK,
        Memory: memoryLimitBytes,
        NanoCpus: Math.round(spec.cpu * 1e9),
        Binds: binds.length ? binds : undefined,
        // Templates can opt into a relaxed security profile (sudo works,
        // root can chown/chmod, etc.) by setting spec.allowRoot=true. Default
        // posture stays locked down (CapDrop:ALL + no-new-privileges).
        CapDrop: spec.allowRoot === true ? undefined : ['ALL'],
        CapAdd: spec.capAdd?.length ? spec.capAdd : undefined,
        Sysctls: spec.sysctls && Object.keys(spec.sysctls).length ? spec.sysctls : undefined,
        Tmpfs: spec.tmpfs && Object.keys(spec.tmpfs).length ? spec.tmpfs : undefined,
        ShmSize: spec.shmSizeMb ? spec.shmSizeMb * 1024 * 1024 : undefined,
        Devices: devices.length ? devices : undefined,
        Privileged: spec.privileged === true,
        SecurityOpt: spec.allowRoot === true ? undefined : ['no-new-privileges:true'],
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
        // Always publish the lab port. The wildcard proxy reaches us via
        // `<node.proxyHost>:<assigned-host-port>` — there is no shared
        // labnet across nodes. We bind to `node.bindIp` so operators can
        // restrict exposure to a private interface.
        PortBindings: portBindings,
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
    // Resolve extras (e.g. RDP). Non-fatal if missing — caller decides
    // whether the absence is an error.
    const extraHostPorts: Record<number, number> = {};
    for (const cp of req.extraPortBindings ?? []) {
      if (cp === spec.port) continue;
      const b = info.NetworkSettings?.Ports?.[`${cp}/tcp`]?.[0];
      if (b?.HostPort) extraHostPorts[cp] = Number(b.HostPort);
    }
    return {
      runtimeId: container.id,
      upstream: `${this.proxyHost}:${hostPort}`,
      hostPort: Number(hostPort),
      extraHostPorts: Object.keys(extraHostPorts).length ? extraHostPorts : undefined,
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

  async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode === 404) return false;
      // Treat any other error (network, ssh, etc.) as 'unknown' — caller
      // must not assume the volume is absent on a transient failure.
      throw err;
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

  /**
   * Re-inspect a container and report its currently published host port.
   * Docker reassigns ephemeral ports on every `docker start`, so the value
   * we stored at provision-time goes stale across host reboots and even
   * across resume() on a daemon that doesn't preserve port maps. The
   * orchestrator calls this after resume/restart and PERSISTS any drift
   * so the wildcard proxy keeps routing to the right port.
   *
   * Picks the first port mapping with a non-empty `HostPort` — labs only
   * ever publish a single port, so there's nothing ambiguous to choose.
   */
  async inspectInstance(
    runtimeId: string,
  ): Promise<{
    running: boolean;
    hostPort?: number;
    upstream?: string;
    allHostPorts?: Record<string, number>;
  } | null> {
    try {
      const info = await this.docker.getContainer(runtimeId).inspect();
      const running = !!info.State?.Running;
      const portsMap = (info.NetworkSettings?.Ports ?? {}) as Record<
        string,
        Array<{ HostIp?: string; HostPort?: string }> | null
      >;
      let hostPort: number | undefined;
      const allHostPorts: Record<string, number> = {};
      for (const [key, bindings] of Object.entries(portsMap)) {
        if (!bindings || bindings.length === 0) continue;
        const p = Number(bindings[0]?.HostPort);
        if (!Number.isFinite(p) || p <= 0) continue;
        allHostPorts[key] = p;
        // Keep the legacy "first match wins" for the primary hostPort —
        // most labs publish exactly one port and that's what the wildcard
        // proxy needs. Callers wanting a specific container port read
        // `allHostPorts` directly.
        if (hostPort === undefined) hostPort = p;
      }
      return hostPort
        ? {
            running,
            hostPort,
            upstream: `${this.proxyHost}:${hostPort}`,
            allHostPorts,
          }
        : { running, allHostPorts };
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode === 404) return null;
      throw err;
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

  private async ensureNetwork(name: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).inspect();
      return;
    } catch (err: unknown) {
      const e = err as { statusCode?: number };
      if (e.statusCode !== 404) throw err;
    }
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Labels: { 'labforge.managed': 'true' },
      });
    } catch (err: unknown) {
      // 409 = a concurrent provision created it first.
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
