import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import { prisma } from './db.js';
import { verifySessionToken } from './auth/jwt.js';
import { config } from './config.js';
import { resumeInstance, waitUntilReady } from './orchestrator.js';

/**
 * Reverse-proxies wildcard host `{subdomain}.<PUBLIC_LAB_DOMAIN>` to the
 * matching lab container on the docker network. Handles HTTP and WebSocket
 * upgrades. Validates the `lf_session` cookie.
 *
 * In production this responsibility moves to Traefik/Envoy (see
 * packages/gateway). The Fastify implementation here keeps the dev story
 * single-binary.
 */
export async function registerWildcardProxy(app: FastifyInstance): Promise<void> {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    proxyTimeout: 30_000,
    timeout: 60_000,
  });

  proxy.on('error', (err, _req, res) => {
    app.log.warn({ err: err.message }, '[proxy] upstream error');
    const r = res as ServerResponse | undefined;
    if (r && !r.headersSent) {
      r.statusCode = 502;
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ error: 'upstream_unavailable' }));
    }
  });

  // --- HTTP path: intercept before Fastify routing ---
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    if (!isLabHost(host)) return; // pass through to normal routes

    const subdomain = host.slice(0, host.length - config.PUBLIC_LAB_DOMAIN.length - 1);
    const decision = await resolveAndAuth(subdomain, req.headers.cookie);
    if ('error' in decision) {
      reply.code(decision.code).send({ error: decision.error });
      return;
    }

    reply.hijack();
    proxy.web(req.raw, reply.raw, {
      target: `http://${decision.upstream}`,
      changeOrigin: false,
    });
  });

  // --- WebSocket path: hook the underlying HTTP server's upgrade event ---
  app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
      if (!isLabHost(host)) {
        // Not for us — let Fastify's own ws handlers (if any) take over.
        return;
      }
      const subdomain = host.slice(0, host.length - config.PUBLIC_LAB_DOMAIN.length - 1);
      const decision = await resolveAndAuth(subdomain, req.headers.cookie);
      if ('error' in decision) {
        socket.write(`HTTP/1.1 ${decision.code} ${decision.error}\r\n\r\n`);
        socket.destroy();
        return;
      }
      proxy.ws(req, socket, head, {
        target: `http://${decision.upstream}`,
        changeOrigin: false,
      });
    })().catch((err) => {
      app.log.error({ err: (err as Error).message }, '[proxy] ws hook error');
      socket.destroy();
    });
  });
}

function isLabHost(host: string): boolean {
  // host must look like `<sub>.<PUBLIC_LAB_DOMAIN>` and have a real subdomain.
  const suffix = `.${config.PUBLIC_LAB_DOMAIN.toLowerCase()}`;
  return host.endsWith(suffix) && host.length > suffix.length;
}

type Decision =
  | { upstream: string; instanceId: string }
  | { error: string; code: number };

async function resolveAndAuth(
  subdomain: string,
  cookieHeader: string | undefined,
): Promise<Decision> {
  const instance = await prisma.labInstance.findUnique({ where: { subdomain } });
  if (!instance || !instance.upstream) {
    return { error: 'unknown_instance', code: 404 };
  }
  if (instance.status === 'terminated' || instance.status === 'failed') {
    return { error: 'instance_unavailable', code: 410 };
  }
  const cookie = parseCookie(cookieHeader, 'lf_session');
  if (!cookie) return { error: 'no_session', code: 401 };
  try {
    const claims = await verifySessionToken(cookie);
    if (claims.sub !== instance.id || claims.tenantId !== instance.tenantId) {
      return { error: 'session_mismatch', code: 403 };
    }
  } catch {
    return { error: 'invalid_session', code: 401 };
  }

  // Auto-resume if the lab was suspended by the reaper. The student clicked
  // a bookmarked subdomain URL; we don't make them re-redeem.
  if (instance.status === 'paused' && instance.runtimeId) {
    try {
      await resumeInstance(instance.id, {
        waitMs: config.RESUME_WAIT_TIMEOUT_SECONDS * 1000,
      });
    } catch {
      return { error: 'resume_failed', code: 503 };
    }
  } else if (instance.status === 'ready' && instance.runtimeId) {
    // Already "ready" in DB, but the container may have just been started
    // by another path — do a fast readiness check so we don't 502.
    if (!(await fastIsReady(instance.runtimeId, instance.upstream))) {
      const ok = await waitUntilReady(
        instance.runtimeId,
        instance.upstream,
        config.RESUME_WAIT_TIMEOUT_SECONDS * 1000,
      );
      if (!ok) return { error: 'upstream_not_ready', code: 503 };
    }
  }

  // Fire-and-forget heartbeat. lastSeenAt = any traffic, lastActivityAt =
  // student-facing traffic specifically (drives idle→suspend decisions).
  const nowDate = new Date();
  void prisma.labInstance
    .update({
      where: { id: instance.id },
      data: { lastSeenAt: nowDate, lastActivityAt: nowDate },
    })
    .catch(() => {});

  return { upstream: instance.upstream, instanceId: instance.id };
}

async function fastIsReady(runtimeId: string, upstream: string): Promise<boolean> {
  try {
    const { getRuntime } = await import('./runtime/index.js');
    return await getRuntime().isReady(runtimeId, upstream);
  } catch {
    return false;
  }
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
