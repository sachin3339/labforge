import { z } from 'zod';

/**
 * Public schemas + types shared between control-plane, gateway, and (future)
 * SDKs. Keep this file dependency-free apart from zod so it can be imported
 * anywhere.
 */

// ---------- Lab template ----------

export const LabRuntimeKind = z.enum([
  'code-server', // VS Code in browser
  'jupyter', // JupyterLab
  'terminal', // ttyd shell only
  'linux-desktop', // KasmVNC / Selkies full desktop in a Linux container
  'vm', // QEMU-in-container (e.g. dockur/windows) — needs /dev/kvm on host
]);
export type LabRuntimeKind = z.infer<typeof LabRuntimeKind>;

export const LabTemplateSpec = z.object({
  image: z.string().min(1),
  runtime: LabRuntimeKind,
  /** Port inside the container the browser connects to. */
  port: z.number().int().positive().default(8080),
  /**
   * Protocol the lab container speaks on `port`. Default is plain HTTP, but
   * Kasm-based desktops (and a few other images) only accept HTTPS on the
   * upstream. The wildcard proxy reads this to pick the target scheme and
   * disables TLS verification for `https` (self-signed certs are normal).
   */
  upstreamScheme: z.enum(['http', 'https']).default('http'),
  cpu: z.number().positive().default(1),
  memoryMb: z.number().int().positive().default(1024),
  env: z.record(z.string()).default({}),
  /** Optional workspace path mounted as the user's persistent dir. */
  workspaceDir: z.string().default('/home/coder/project'),
  /**
   * Container paths that should be persisted to a per-user named Docker
   * volume. The same paths are mounted every time we (re)provision a
   * container for the same student, so their files survive container
   * restarts, suspends, and reschedules.
   *
   * Examples:
   *   - vscode-node:     ['/home/coder']
   *   - ubuntu-desktop:  ['/root', '/home']
   *   - jupyter-python:  ['/home/jovyan']
   *   - windows-11 (VM): ['/storage']  // qemu disk image
   *
   * Leave empty for stateless labs (rare — even then, most students expect
   * their work to survive a refresh).
   */
  persistPaths: z.array(z.string()).default([]),
  /** How many warm instances to keep ready. */
  prewarm: z.number().int().min(0).max(50).default(0),

  // ---- Advanced HostConfig knobs (needed by desktops / VM kinds) ----

  /** Host devices to expose into the container, e.g. ['/dev/kvm']. */
  devices: z.array(z.string()).default([]),
  /** Linux capabilities to add back after CapDrop:ALL, e.g. ['NET_ADMIN']. */
  capAdd: z.array(z.string()).default([]),
  /** Sysctls inside the container, e.g. { 'net.ipv4.ip_forward': '1' }. */
  sysctls: z.record(z.string()).default({}),
  /** tmpfs mounts, e.g. { '/tmp': 'size=512m' } — speeds desktop labs. */
  tmpfs: z.record(z.string()).default({}),
  /** Shared memory size in MB. Browsers / Chromium-based desktops need >=512. */
  shmSizeMb: z.number().int().positive().optional(),
  /**
   * Run container privileged. **Required** for nested QEMU/KVM (VM kind).
   * Gated by LAB_ALLOW_PRIVILEGED on the control plane — refused otherwise.
   */
  privileged: z.boolean().default(false),
  /**
   * Relax the default lock-down so the in-container user can use sudo and
   * root operations work normally. Drops `CapDrop:ALL` and the
   * `no-new-privileges` security-opt. Use for training images where
   * students need apt-get / service control. Does NOT imply --privileged.
   */
  allowRoot: z.boolean().default(false),

  // ---- Pricing (powers the admin Cost & Margin report) ----

  /**
   * Estimated infrastructure cost of running ONE instance of this template
   * for ONE hour, in USD. Used to compute total cost in reports.
   *   - vscode-node, ubuntu-terminal: ~0.01-0.02
   *   - desktop (kasm/selkies):       ~0.03-0.05
   *   - windows-11 VM (6 vCPU/8GB):   ~0.10-0.15
   * Leave undefined to exclude this template from cost rollups.
   */
  costPerHourUsd: z.number().nonnegative().optional(),
  /**
   * List price per redeemed launch (revenue per student), in USD. Used to
   * compute revenue and margin. Set per-template so different tiers
   * (terminal, desktop, Windows VM) can carry different price points.
   */
  priceListUsd: z.number().nonnegative().optional(),

  /**
   * Optional CMD override (docker `Cmd`). When set, replaces the image's
   * default startup command. Use for fine-grained control like passing
   * `--ServerApp.token=` to JupyterLab to disable token auth (the env-var
   * route is unreliable across image versions). Each element becomes one
   * argv slot.
   */
  command: z.array(z.string()).optional(),

  /** Optional auto-grader. Runs inside the lab container on demand. */
  grader: z.optional(z.lazy(() => GraderSpec)),

  // ---- VM-kind extras (linked clones + RDP gateway) ----

  /**
   * Absolute path on the worker node to a read-only "golden" raw disk
   * image. When set, the orchestrator creates a per-instance qcow2
   * overlay backed by this file and mounts the overlay's directory as
   * `/storage` inside the dockur/windows container, instead of using
   * the named-volume pattern. This is how Windows VM labs scale: one
   * 30 GiB golden image + N tiny overlays instead of N 64 GiB volumes.
   *
   * Example: '/opt/labforge/win-golden/golden.img'
   *
   * Ignored unless `runtime: 'vm'`.
   */
  vmGoldenImage: z.string().optional(),
  /**
   * Logical size of the per-instance qcow2 overlay (passed to
   * `qemu-img create`). Must be >= the golden image's virtual size.
   * Example: '64G'. Ignored unless `vmGoldenImage` is set.
   */
  vmOverlaySize: z.string().default('64G'),
  /**
   * Base directory on the worker node where per-instance overlay
   * directories are created (`<base>/<instanceId>/disk.img`). The
   * directory is bind-mounted into the container at `/storage`.
   */
  vmStorageHostBase: z.string().default('/opt/labforge/instances'),

  /**
   * Which client the redeem flow should hand the student. `auto` lets
   * the control-plane pick based on runtime: vm-kind with rdpUsername
   * set → guacamole-rdp; everything else → native-http (the existing
   * subdomain-proxy path). `novnc` keeps the legacy in-container
   * noVNC viewer (dockur :8006) for debugging.
   */
  viewer: z.enum(['auto', 'native-http', 'novnc', 'guacamole-rdp']).default('auto'),
  /**
   * RDP username inside the VM. For dockur/windows the default account
   * is `Docker`. Required when `viewer = 'guacamole-rdp'`.
   */
  rdpUsername: z.string().optional(),
  /**
   * RDP password inside the VM. Stored in the spec JSON for now; rotate
   * by editing the template. Treat as a secret — never logged, redacted
   * in admin API responses (handled in routes/templates.ts).
   */
  rdpPassword: z.string().optional(),
  /** RDP port the VM listens on inside the container. Default 3389 (dockur). */
  rdpContainerPort: z.number().int().positive().default(3389),
});
export type LabTemplateSpec = z.infer<typeof LabTemplateSpec>;

// ---------- Grader ----------

export const GraderCheck = z.object({
  id: z.string().min(1).max(64),
  description: z.string().max(256).default(''),
  /** Shell command executed inside the lab container. */
  command: z.string().min(1),
  /** Optional working dir; defaults to template workspaceDir. */
  workdir: z.string().optional(),
  /** Exit code that counts as a pass. Default 0. */
  passExitCode: z.number().int().default(0),
  /** Optional regex against stdout; if set, must match for a pass. */
  passStdoutRegex: z.string().optional(),
  /** Points awarded if this check passes. */
  weight: z.number().nonnegative().default(1),
  /** Max seconds to wait before the check is marked failed. */
  timeoutSeconds: z.number().int().positive().max(300).default(30),
});
export type GraderCheck = z.infer<typeof GraderCheck>;

export const GraderSpec = z.object({
  checks: z.array(GraderCheck).min(1),
  /** Minimum total score (0..1) required to count as passed. Default 0.5. */
  passThreshold: z.number().min(0).max(1).default(0.5),
});
export type GraderSpec = z.infer<typeof GraderSpec>;

export const GraderCheckResult = z.object({
  id: z.string(),
  passed: z.boolean(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
});
export type GraderCheckResult = z.infer<typeof GraderCheckResult>;

export const GradingResultDTO = z.object({
  id: z.string(),
  launchId: z.string().nullable(),
  instanceId: z.string(),
  score: z.number(),
  maxScore: z.number(),
  passed: z.boolean(),
  checks: z.array(GraderCheckResult),
  createdAt: z.string(),
});
export type GradingResultDTO = z.infer<typeof GradingResultDTO>;

// ---------- Launch ----------

export const LaunchRequest = z.object({
  templateId: z.string().min(1),
  /** Stable LMS user id (we hash it; we never log it raw). */
  userId: z.string().min(1).max(256),
  userDisplayName: z.string().max(128).optional(),
  durationMinutes: z.number().int().min(5).max(525600).default(120),
  /** Where to send the student when they exit the lab. */
  returnUrl: z.string().url().optional(),
  /** Webhook for lifecycle events (HMAC-signed). */
  webhookUrl: z.string().url().optional(),
  /** Free-form context (course id, lesson id, etc.). Stored, returned in webhooks. */
  context: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export const LaunchResponse = z.object({
  launchId: z.string(),
  launchUrl: z.string().url(),
  expiresAt: z.string(), // ISO8601
});
export type LaunchResponse = z.infer<typeof LaunchResponse>;

// ---------- Batch launch (admin-issued, multi-seat) ----------

/**
 * Admin creates N pre-signed launch URLs in one call. The URLs are
 * shareable / embeddable until they're redeemed (single-use) or the launch
 * token expires (default 7 days vs. 60 s for LMS-mediated launches).
 *
 * Used when an operator pre-provisions seats for a corporate client and
 * hands the URL list off as CSV / Excel / pasted into an LMS module.
 */
export const BatchLaunchRequest = z.object({
  templateId: z.string().min(1),
  count: z.number().int().min(1).max(500),
  /** Lab session length once the URL is redeemed. */
  durationMinutes: z.number().int().min(5).max(525600).default(120),
  /**
   * How long the launch URL itself stays valid. The URL is reusable
   * within this window — the same student can revisit it across days,
   * devices, or after clearing cookies, and will be reconnected to (or
   * reissued) their lab.
   */
  ttlHours: z.number().int().min(1).max(8760).default(720),
  /** Friendly label visible in admin (e.g. "LTIM-DevOps-Cohort-7"). */
  label: z.string().min(1).max(120),
  /** Optional per-seat display names (length must match `count`). */
  seatNames: z.array(z.string().max(128)).optional(),
  /** Webhook for lifecycle events. */
  webhookUrl: z.string().url().optional(),
  /** Where redeemed labs send the student on exit. */
  returnUrl: z.string().url().optional(),
});
export type BatchLaunchRequest = z.infer<typeof BatchLaunchRequest>;

export const BatchLaunchItem = z.object({
  launchId: z.string(),
  seat: z.number().int().min(1),
  displayName: z.string(),
  launchUrl: z.string().url(),
  expiresAt: z.string(),
});
export type BatchLaunchItem = z.infer<typeof BatchLaunchItem>;

export const BatchLaunchResponse = z.object({
  batchId: z.string(),
  label: z.string(),
  templateId: z.string(),
  count: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
  launches: z.array(BatchLaunchItem),
});
export type BatchLaunchResponse = z.infer<typeof BatchLaunchResponse>;

/** Summary row for `GET /api/v1/batches`. */
export const BatchSummary = z.object({
  batchId: z.string(),
  label: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  count: z.number().int(),
  redeemed: z.number().int(),
  active: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type BatchSummary = z.infer<typeof BatchSummary>;

// ---------- JWT claims ----------

/** Short-lived (≤60s) one-time token in the launch URL. */
export interface LaunchTokenClaims {
  iss: string;
  sub: string; // launchId
  aud: 'labforge:launch';
  tenantId: string;
  templateId: string;
  userIdHash: string;
  iat: number;
  exp: number;
  jti: string;
}

/** Long-lived (hours) session cookie issued by the gateway after redeeming a launch token. */
export interface SessionTokenClaims {
  iss: string;
  sub: string; // instanceId
  aud: 'labforge:session';
  tenantId: string;
  userIdHash: string;
  iat: number;
  exp: number;
}

// ---------- Instance ----------

export const LabInstanceStatus = z.enum([
  'pending',
  'provisioning',
  'ready',
  'idle',
  'paused',
  'terminating',
  'terminated',
  'failed',
]);
export type LabInstanceStatus = z.infer<typeof LabInstanceStatus>;

export const LabInstanceDTO = z.object({
  id: z.string(),
  tenantId: z.string(),
  templateId: z.string(),
  status: LabInstanceStatus,
  url: z.string().url().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type LabInstanceDTO = z.infer<typeof LabInstanceDTO>;
