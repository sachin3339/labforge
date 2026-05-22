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

  /** Optional auto-grader. Runs inside the lab container on demand. */
  grader: z.optional(z.lazy(() => GraderSpec)),
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
  durationMinutes: z.number().int().min(5).max(480).default(120),
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
  durationMinutes: z.number().int().min(5).max(480).default(120),
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
