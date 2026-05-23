import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Socket } from 'node:net';
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
    forwardHttp(req.raw, reply.raw, decision, app.log);
  });

  // --- WebSocket path: hook the underlying HTTP server's upgrade event ---
  app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
      if (!isLabHost(host)) return;
      const subdomain = host.slice(0, host.length - config.PUBLIC_LAB_DOMAIN.length - 1);
      const decision = await resolveAndAuth(subdomain, req.headers.cookie, app.log);
      if (decision.kind !== 'ok') {
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
      forwardUpgrade(req, socket, head, decision, app.log);
    })().catch((err) => {
      app.log.error({ err: (err as Error).message }, '[proxy] ws hook error');
      socket.destroy();
    });
  });
}

/**
 * Forward an HTTP request to the upstream container. We build the outgoing
 * request manually (instead of using http-proxy) because http-proxy was
 * silently dropping the injected Authorization header for Kasm desktops.
 */
function forwardHttp(
  req: IncomingMessage,
  res: http.ServerResponse,
  decision: Extract<Decision, { kind: 'ok' }>,
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): void {
  const [hostname, portStr] = decision.upstream.split(':');
  const port = Number(portStr);

  // Build outgoing headers from scratch — copying req.headers wholesale can
  // include hop-by-hop headers (connection: upgrade etc.) that cause Node
  // to silently drop Authorization. Forward only end-to-end headers.
  const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
  ]);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  // changeOrigin: Kasm validates Host against container:port.
  headers.Host = decision.upstream;
  delete headers.host;
  delete headers.authorization;
  if (decision.injectAuth) {
    // NB: capital 'A' is required — KasmVNC's HTTP parser is case-sensitive
    // and ignores `authorization` (lowercase).
    headers.Authorization = decision.injectAuth;
  }
  const remote = req.socket.remoteAddress ?? '';
  const prevXff = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = prevXff ? `${prevXff}, ${remote}` : remote;

  const opts: https.RequestOptions = {
    hostname,
    port,
    method: req.method,
    path: req.url,
    headers,
    rejectUnauthorized: false,
  };
  const requester = decision.scheme === 'https' ? https.request : http.request;
  log.info(
    `[proxy] ${req.method} ${req.url} → ${decision.scheme}://${decision.upstream} ` +
      `auth=${headers.authorization ? 'yes' : 'no'} ` +
      `header-keys=${Object.keys(headers).join(',')}`,
  );

  const upstream = requester(opts, (upRes) => {
    // Allow the lab UI to be embedded by configured LMS origins. Strip
    // upstream X-Frame-Options and any `frame-ancestors` directive in CSP,
    // then apply our own based on LAB_FRAME_ANCESTORS.
    const outHeaders = { ...upRes.headers } as http.OutgoingHttpHeaders;
    delete outHeaders['x-frame-options'];
    delete outHeaders['X-Frame-Options'];
    const csp = outHeaders['content-security-policy'];
    if (typeof csp === 'string') {
      const cleaned = csp
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && !/^frame-ancestors\b/i.test(d))
        .join('; ');
      outHeaders['content-security-policy'] = cleaned
        ? `${cleaned}; frame-ancestors ${config.LAB_FRAME_ANCESTORS}`
        : `frame-ancestors ${config.LAB_FRAME_ANCESTORS}`;
    } else {
      outHeaders['content-security-policy'] = `frame-ancestors ${config.LAB_FRAME_ANCESTORS}`;
    }
    res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, outHeaders);
    upRes.pipe(res);
  });
  upstream.on('error', (err: Error) => {
    log.warn(`[proxy] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'upstream_unavailable' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

/**
 * Forward a WebSocket / HTTP upgrade to the upstream. Opens a raw TLS (or
 * TCP) socket to the container, writes the HTTP/1.1 request line + headers
 * with Authorization injected, then bidirectionally pipes.
 */
function forwardUpgrade(
  req: IncomingMessage,
  client: Socket,
  head: Buffer,
  decision: Extract<Decision, { kind: 'ok' }>,
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): void {
  const [hostname, portStr] = decision.upstream.split(':');
  const port = Number(portStr);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  headers.Host = decision.upstream;
  delete headers.host;
  delete headers.authorization;
  if (decision.injectAuth) {
    // Capital 'A' — KasmVNC's HTTP parser is case-sensitive.
    headers.Authorization = decision.injectAuth;
  }
  // Ensure the upgrade headers are present and properly cased. KasmVNC's
  // websockify parser requires Connection: Upgrade and Upgrade: websocket.
  delete headers.connection;
  delete headers.upgrade;
  headers.Connection = 'Upgrade';
  headers.Upgrade = 'websocket';
  const remote = req.socket.remoteAddress ?? '';
  headers['x-forwarded-for'] = headers['x-forwarded-for']
    ? `${headers['x-forwarded-for']}, ${remote}`
    : remote;

  log.info(
    `[proxy] WS ${req.url} → ${decision.scheme}://${decision.upstream} ` +
      `auth=${decision.injectAuth ? 'yes' : 'no'}`,
  );

  const connect = decision.scheme === 'https'
    ? () => tls.connect({ host: hostname, port, rejectUnauthorized: false, servername: hostname })
    : () => net.connect({ host: hostname, port });
  const upstream = connect();

  const onError = (err: Error) => {
    log.warn(`[proxy] ws upstream error: ${err.message}`);
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', onError);
  client.on('error', onError);

  const onReady = () => {
    let raw = `${req.method ?? 'GET'} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  };
  if (decision.scheme === 'https') {
    (upstream as tls.TLSSocket).once('secureConnect', onReady);
  } else {
    (upstream as net.Socket).once('connect', onReady);
  }
}

function isLabHost(host: string): boolean {
  // host must look like `<sub>.<PUBLIC_LAB_DOMAIN>` and have a real subdomain.
  const suffix = `.${config.PUBLIC_LAB_DOMAIN.toLowerCase()}`;
  return host.endsWith(suffix) && host.length > suffix.length;
}

type Decision =
  | {
      kind: 'ok';
      upstream: string;
      scheme: 'http' | 'https';
      instanceId: string;
      /**
       * If set, the proxy will overwrite the incoming `Authorization` header
       * with this value before forwarding. Used for Kasm desktops so that the
       * browser never sees the upstream HTTP-Basic challenge popup.
       */
      injectAuth?: string;
    }
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
  // Read upstream scheme from the template spec. Kasm-based desktops only
  // accept HTTPS upstream; everything else defaults to plain HTTP. We resolve
  // it BEFORE the readiness probe so the probe targets the correct scheme.
  const spec = (instance.template.spec ?? {}) as {
    upstreamScheme?: 'http' | 'https';
    env?: Record<string, string>;
  };
  const scheme: 'http' | 'https' = spec.upstreamScheme === 'https' ? 'https' : 'http';

  // Kasm desktops gate the noVNC UI behind HTTP Basic auth (user=`kasm_user`,
  // password=`VNC_PW`). We inject that header server-side so students never
  // see the browser's native sign-in popup.
  const vncPw = spec.env?.VNC_PW;
  const injectAuth =
    scheme === 'https' && vncPw
      ? `Basic ${Buffer.from(`kasm_user:${vncPw}`).toString('base64')}`
      : undefined;

  if (instance.runtimeId && !(await fastIsReady(instance.runtimeId, instance.upstream, scheme))) {
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

  return {
    kind: 'ok',
    upstream: instance.upstream,
    scheme,
    instanceId: instance.id,
    injectAuth,
  };
}

async function fastIsReady(
  runtimeId: string,
  upstream: string,
  scheme: 'http' | 'https',
): Promise<boolean> {
  try {
    return await getRuntime().isReady(runtimeId, upstream, scheme);
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
