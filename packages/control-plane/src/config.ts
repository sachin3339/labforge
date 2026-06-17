import { z } from 'zod';
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Auto-load env files for native (non-container) dev. In production / inside
// containers, env is provided by the orchestrator and these files are absent.
// `.env.local` wins over `.env` so devs can override without touching the
// committed sample.
for (const fname of ['.env.local', '.env']) {
  for (const dir of [process.cwd(), resolve(process.cwd(), '../..')]) {
    const p = resolve(dir, fname);
    if (existsSync(p)) {
      loadEnv({ path: p, override: false });
      break;
    }
  }
}

/**
 * Centralised env parsing. Fails fast at startup if anything required is
 * missing — better than mysterious runtime errors later.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_PRIVATE_KEY_B64: z.string().min(1),
  JWT_PUBLIC_KEY_B64: z.string().min(1),
  JWT_ISSUER: z.string().default('labforge'),
  JWT_LAUNCH_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  JWT_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(14_400),

  PUBLIC_API_URL: z.string().url(),
  PUBLIC_LAB_DOMAIN: z.string().min(1),
  PUBLIC_GATEWAY_URL: z.string().url(),

  RUNTIME: z.enum(['docker', 'mock']).default('docker'),
  DOCKER_HOST_SOCKET: z.string().default('/var/run/docker.sock'),
  DOCKER_NETWORK: z.string().default('labforge_labnet'),
  /**
   * Publish lab container ports to ephemeral host ports. Required when the
   * control plane runs OUTSIDE the labnet (dev on Windows). Leave false in
   * prod so labs stay unreachable from the host.
   */
  LAB_PUBLISH_PORTS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Permit templates with `privileged: true` or device passthrough (e.g.
   * `/dev/kvm`). Required for VM-kind labs (dockur/windows, qemu-in-container).
   * Default off — only enable on hosts you trust the template authors on
   * AND that actually have nested-virt / KVM.
   */
  LAB_ALLOW_PRIVILEGED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  LAB_DEFAULT_CPU: z.coerce.number().positive().default(1),
  LAB_DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(1024),
  LAB_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(525600),
  LAB_MAX_DURATION_MINUTES: z.coerce.number().int().positive().default(525600),

  /**
   * After this many minutes of no student activity, a running lab is
   * suspended (docker stop). Disk + volumes are preserved; resume on next
   * redeem brings the same state back. This is the cost saver — the host
   * can hold hundreds of suspended labs (only disk used) while only the
   * actively-in-use ones consume CPU/RAM.
   */
  LAB_SUSPEND_IDLE_MINUTES: z.coerce.number().int().positive().default(525600),
  /**
   * If a lab has been suspended this long with no student activity, the
   * reaper hard-terminates it (container + volume gone) to reclaim disk.
   * Independent of batch expiry — protects against forgotten labs.
   */
  LAB_HARD_INACTIVITY_DAYS: z.coerce.number().int().positive().default(365),
  /**
   * Max seconds the redeem endpoint will wait for a resumed container's
   * upstream port to respond before falling back to the HTML "warming up"
   * page (which auto-refreshes).
   */
  RESUME_WAIT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),

  REAPER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  REAPER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  PREWARM_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  PREWARM_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),

  /**
   * Background reconciliation that re-inspects active runtimes and fixes
   * DB/network drift caused by out-of-band Docker restarts on worker nodes.
   */
  PORT_DRIFT_RECONCILE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  PORT_DRIFT_RECONCILE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(20),

  /**
   * Space-separated list of origins permitted to embed lab UIs in iframes.
   * Default '*' allows embedding from anywhere (suitable for dev and for
   * LMS integrations). For a stricter prod setup, set this to e.g.
   *   "https://lxp.example.com https://admin.environments.learnlytica.com"
   *
   * Setting this also strips upstream `X-Frame-Options` and any
   * `frame-ancestors` directive in upstream Content-Security-Policy headers,
   * so containers like Kasm / code-server stop blocking the iframe.
   */
  LAB_FRAME_ANCESTORS: z.string().default('*'),

  /**
   * Multi-node placement policy when no tenant/template pin applies.
   *   - 'spread'  : pick the enabled+healthy node with the fewest active
   *                 instances (default — what you want for "spin up 50 of
   *                 templateX" workloads).
   *   - 'pinned'  : skip load-spread; fall straight through to the Node
   *                 row flagged isDefault=true (preserves old single-box
   *                 behaviour for operators who want strict pinning).
   */
  LAB_SCHEDULER: z.enum(['spread', 'pinned']).default('spread'),

  /**
   * How often the health poller pings every enabled node and refreshes
   * Node.lastSeenAt / lastError / dockerVersion. Drives both the UI
   * status dot AND the scheduler's "is this node healthy?" filter.
   */
  NODE_HEALTH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  /**
   * A node whose lastSeenAt is older than this is considered offline by
   * the scheduler (excluded from spread placement). Keep generous — 3x
   * the poll interval so one missed tick doesn't pull a node out of
   * rotation.
   */
  NODE_HEALTH_STALE_SECONDS: z.coerce.number().int().positive().default(120),
});

export type AppConfig = z.infer<typeof Env>;

export const config: AppConfig = Env.parse(process.env);

export const decodeB64 = (b64: string): string =>
  Buffer.from(b64, 'base64').toString('utf8');
