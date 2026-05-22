import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import { prisma } from './db.js';
import { verifySessionToken } from './auth/jwt.js';
import { config } from './config.js';
import { resumeInstance } from './orchestrator.js';
import { getRuntime } from './runtime/index.js';
import { warmingUpHtml, unavailableHtml } from './ui/warmingPage.js';

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
    const decision = await resolveAndAuth(subdomain, req.headers.cookie, app.log);

    if (decision.kind === 'warming') {
      reply
        .code(202)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(warmingUpHtml(decision.templateName));
      return;
    }
    if (decision.kind === 'unavailable') {
      reply
        .code(decision.code)
        .header('content-type', 'text/html; charset=utf-8')
        .send(unavailableHtml(decision.reason));
      return;
    }
    if (decision.kind === 'error') {
      reply.code(decision.code).send({ error: decision.error });
      return;
    }

    reply.hijack();
    proxy.web(req.raw, reply.raw, {
      target: `${decision.scheme}://${decision.upstream}`,
      changeOrigin: false,
      secure: false,
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
      const decision = await resolveAndAuth(subdomain, req.headers.cookie, app.log);
      if (decision.kind !== 'ok') {
        // Can't render HTML on a websocket. Close the socket with a status
        // line that mirrors the HTTP decision; the client (e.g. noVNC) will
        // surface this as a disconnect and the auto-refreshing HTML page
        // wrapping the iframe will handle the wait.
        const code = decision.kind === 'warming' ? 503 : decision.code;
        const reason =
          decision.kind === 'warming'
            ? 'lab_warming_up'
            : decision.kind === 'unavailable'
              ? decision.reason
              : decision.error;
        socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
        socket.destroy();
        return;
      }
      proxy.ws(req, socket, head, {
        target: `${decision.scheme}://${decision.upstream}`,
        changeOrigin: false,
        secure: false,
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
  | { kind: 'ok'; upstream: string; scheme: 'http' | 'https'; instanceId: string }
  | { kind: 'warming'; templateName: string }
  | { kind: 'unavailable'; reason: string; code: number }
  | { kind: 'error'; error: string; code: number };

/**
 * In-flight resume guard. Prevents the proxy from calling
 * `resumeInstance` repeatedly while a refreshing browser hammers the
 * subdomain. Single-process scope is fine here (we run one control-plane
 * pod for now); a multi-node deploy would replace this with a Redis lock.
 */
const resumingNow = new Set<string>();

async function resolveAndAuth(
  subdomain: string,
  cookieHeader: string | undefined,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<Decision> {
  const instance = await prisma.labInstance.findUnique({
    where: { subdomain },
    include: { template: true },
  });
  if (!instance || !instance.upstream) {
    return { kind: 'unavailable', reason: 'unknown_instance', code: 404 };
  }
  if (instance.status === 'terminated' || instance.status === 'failed') {
    return { kind: 'unavailable', reason: 'instance_terminated', code: 410 };
  }

  // Auth before doing anything expensive (or that mutates state).
  const cookie = parseCookie(cookieHeader, 'lf_session');
  if (!cookie) return { kind: 'error', error: 'no_session', code: 401 };
  try {
    const claims = await verifySessionToken(cookie);
    if (claims.sub !== instance.id || claims.tenantId !== instance.tenantId) {
      return { kind: 'error', error: 'session_mismatch', code: 403 };
    }
  } catch {
    return { kind: 'error', error: 'invalid_session', code: 401 };
  }

  // If the reaper suspended the lab, kick off a resume in the background
  // and tell the browser to come back in a moment. We don't block the
  // request — the student gets an instant warming-up page that refreshes
  // itself; the resume completes while they read it.
  if (instance.status === 'paused' && instance.runtimeId) {
    if (!resumingNow.has(instance.id)) {
      resumingNow.add(instance.id);
      void resumeInstance(instance.id, { waitMs: 0 })
        .then(() => {
          logger.info(`[proxy] resumed instance=${instance.id} sub=${subdomain}`);
        })
        .catch((err: Error) => {
          logger.warn(
            `[proxy] resume failed for ${instance.id}: ${err.message}`,
          );
        })
        .finally(() => {
          resumingNow.delete(instance.id);
        });
    }
    return { kind: 'warming', templateName: instance.template.name };
  }

  // Fast readiness check — if upstream isn't listening yet (fresh start,
  // mid-resume, container just restarted by ops), surface the warming
  // page rather than letting the proxy return a raw 502.
  if (instance.status !== 'ready' && instance.status !== 'idle') {
    return { kind: 'warming', templateName: instance.template.name };
  }
  if (instance.runtimeId && !(await fastIsReady(instance.runtimeId, instance.upstream))) {
    return { kind: 'warming', templateName: instance.template.name };
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

  // Read upstream scheme from the template spec. Kasm-based desktops only
  // accept HTTPS upstream; everything else defaults to plain HTTP.
  const spec = (instance.template.spec ?? {}) as { upstreamScheme?: 'http' | 'https' };
  const scheme: 'http' | 'https' = spec.upstreamScheme === 'https' ? 'https' : 'http';

  return { kind: 'ok', upstream: instance.upstream, scheme, instanceId: instance.id };
}

async function fastIsReady(runtimeId: string, upstream: string): Promise<boolean> {
  try {
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
