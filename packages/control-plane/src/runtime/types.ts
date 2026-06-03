import type { LabTemplateSpec } from '@labforge/shared';

export interface VolumeMount {
  /** Named Docker volume (created lazily by the runtime if missing). */
  name: string;
  /** Absolute path inside the container. */
  containerPath: string;
}

/**
 * What the orchestrator hands to a runtime adapter when asking it to bring
 * up a single lab. Runtime-agnostic: docker, k8s, KubeVirt all implement
 * the same surface.
 */
export interface ProvisionRequest {
  instanceId: string;
  /** Unique subdomain segment — routable host name. */
  subdomain: string;
  spec: LabTemplateSpec;
  /** Hashed user id so we can label/observe but not de-anonymise. */
  userIdHash?: string;
  /** Persistent volumes to mount. The runtime creates them if missing. */
  volumes?: VolumeMount[];
  /** Free-form labels for billing/observability. */
  labels: Record<string, string>;
}

export interface ProvisionResult {
  runtimeId: string;
  /** `host:port` the gateway should proxy to. */
  upstream: string;
  /** Host port the lab is published on. Persisted so the proxy can
   *  reconstruct upstream across restarts; optional for non-docker runtimes. */
  hostPort?: number;
}

export interface ExecRequest {
  /** Argv. Use ['sh','-lc','cmd'] for shell expansion. */
  cmd: string[];
  /** Working dir inside the container. */
  workdir?: string;
  /** Env overrides (in addition to the container's env). */
  env?: Record<string, string>;
  /** Hard timeout in ms; resolves with `timedOut:true`, `exitCode:null`. */
  timeoutMs?: number;
  /** Cap each stream at this many bytes; default 64 KiB. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface LabRuntime {
  readonly name: 'docker' | 'k8s' | 'mock';
  /** Provision and return once the container/pod is *running* (not necessarily ready). */
  provision(req: ProvisionRequest): Promise<ProvisionResult>;
  /** Best-effort health check; resolves true if upstream responds. */
  isReady(
    runtimeId: string,
    upstream: string,
    scheme?: 'http' | 'https',
  ): Promise<boolean>;
  /** Stop and remove. Idempotent. */
  destroy(runtimeId: string): Promise<void>;
  /** Stop gracefully but KEEP disk + volumes. Idempotent. */
  suspend(runtimeId: string): Promise<void>;
  /** Start a previously suspended container. Idempotent. */
  resume(runtimeId: string): Promise<void>;
  /** Delete a named persistent volume. Idempotent. */
  destroyVolume(name: string): Promise<void>;
  /** Check if a named persistent volume exists on this runtime's host. */
  volumeExists(name: string): Promise<boolean>;
  /** Execute a command inside the running container/pod. */
  exec(runtimeId: string, req: ExecRequest): Promise<ExecResult>;
  /** Tail the last N lines of combined stdout+stderr (best-effort). */
  logs(runtimeId: string, opts?: { tail?: number }): Promise<string>;
  /** Restart the container/pod in place (stop + start). */
  restart(runtimeId: string): Promise<void>;
  /**
   * Re-inspect a running container/pod and return its currently published
   * host port + upstream string. Used after resume/restart to detect when
   * Docker reassigns the ephemeral port. Returns null if the runtime no
   * longer knows about this id (e.g. container removed).
   */
  inspectInstance(runtimeId: string): Promise<{
    running: boolean;
    hostPort?: number;
    upstream?: string;
  } | null>;
}
