import Docker from 'dockerode';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import type {
  ExecRequest,
  ExecResult,
  LabRuntime,
  ProvisionRequest,
  ProvisionResult,
} from './types.js';

/**
 * Docker runtime adapter. Used for local dev and single-node deployments.
 * Production multi-node will swap in a k8s adapter that implements the same
 * interface.
 *
 * Security notes:
 *   - Containers run on a dedicated user-defined bridge network (`labnet`),
 *     isolated from the host network.
 *   - We do NOT publish ports to the host; the gateway reaches the container
 *     by its DNS name on `labnet` (`<subdomain>.labnet`).
 *   - CPU/memory hard-capped via cgroup limits.
 *   - Read-only root FS where the image allows; `/tmp` mounted tmpfs.
 */
export class DockerRuntime implements LabRuntime {
  readonly name = 'docker' as const;
  private readonly docker: Docker;

  constructor() {
    this.docker = new Docker({ socketPath: config.DOCKER_HOST_SOCKET });
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
        // Dev mode: publish lab port to a random host port so a control
        // plane running OUTSIDE the labnet (e.g. natively on Windows while
        // Podman runs in WSL) can still reach it. Disabled by default —
        // production keeps labs unreachable from the host.
        ...(config.LAB_PUBLISH_PORTS
          ? { PortBindings: { [`${spec.port}/tcp`]: [{ HostPort: '0' }] } }
          : {}),
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

    let upstream: string;
    if (config.LAB_PUBLISH_PORTS) {
      // Inspect to find the host-assigned port
      const info = await container.inspect();
      const binding = info.NetworkSettings?.Ports?.[`${spec.port}/tcp`]?.[0];
      const hostPort = binding?.HostPort;
      if (!hostPort) {
        throw new Error(
          `lab container ${name} started but no host port binding was created`,
        );
      }
      upstream = `127.0.0.1:${hostPort}`;
    } else {
      upstream = `${subdomain}:${spec.port}`;
    }
    return { runtimeId: container.id, upstream };
  }

  async isReady(runtimeId: string, upstream: string): Promise<boolean> {
    try {
      const c = this.docker.getContainer(runtimeId);
      const info = await c.inspect();
      if (!info.State.Running) return false;

      // TCP probe via fetch is overkill for raw TCP — use a simple HTTP HEAD
      // against the upstream. The control plane shares the labnet so DNS
      // resolves.
      const url = `http://${upstream}/`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      try {
        await fetch(url, { method: 'HEAD', signal: ctrl.signal });
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
