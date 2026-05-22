import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { verifySessionToken } from '../auth/jwt.js';

/**
 * Traefik forwardAuth middleware target. For every request hitting
 * {subdomain}.lab.example.com Traefik calls us first with the original
 * Host + Cookie headers. We:
 *   1. Match subdomain → instance.
 *   2. Verify lf_session cookie binds to that instance.
 *   3. Return 200 + X-LF-Upstream header so Traefik proxies upstream.
 *      Or 401/403 to deny.
 */
export const internalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/internal/forward-auth', async (req, reply) => {
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ??
      (req.headers.host as string | undefined) ??
      '';

    // host = "<subdomain>.lab.example.com[:port]"
    const subdomain = host.split('.')[0]?.toLowerCase();
    if (!subdomain) {
      reply.code(400);
      return { error: 'bad_host' };
    }

    const instance = await prisma.labInstance.findUnique({
      where: { subdomain },
    });
    if (!instance || instance.status === 'terminated' || !instance.upstream) {
      reply.code(404);
      return { error: 'unknown_instance' };
    }

    const cookie = parseCookie(req.headers.cookie, 'lf_session');
    if (!cookie) {
      reply.code(401);
      return { error: 'no_session' };
    }

    try {
      const claims = await verifySessionToken(cookie);
      if (claims.sub !== instance.id) {
        reply.code(403);
        return { error: 'session_instance_mismatch' };
      }
      if (claims.tenantId !== instance.tenantId) {
        reply.code(403);
        return { error: 'tenant_mismatch' };
      }
    } catch {
      reply.code(401);
      return { error: 'invalid_session' };
    }

    // Best-effort liveness ping for billing/idle tracking. Don't block the
    // response on it.
    void prisma.labInstance
      .update({ where: { id: instance.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});

    reply
      .header('X-LF-Upstream', instance.upstream)
      .header('X-LF-Instance', instance.id)
      .code(200);
    return { ok: true };
  });

  // Lightweight per-tenant ops endpoints (no auth — bind to private net only).
  app.get('/internal/instances/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const inst = await prisma.labInstance.findUnique({ where: { id } });
    if (!inst) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return inst;
  });
};

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
