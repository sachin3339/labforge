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
  LAB_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10),
  LAB_MAX_DURATION_MINUTES: z.coerce.number().int().positive().default(240),

  PREWARM_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  PREWARM_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
});

export type AppConfig = z.infer<typeof Env>;

export const config: AppConfig = Env.parse(process.env);

export const decodeB64 = (b64: string): string =>
  Buffer.from(b64, 'base64').toString('utf8');
