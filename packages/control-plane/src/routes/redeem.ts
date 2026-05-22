import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { verifyLaunchToken, signSessionToken } from '../auth/jwt.js';
import {
  acquireInstance,
  instanceUrl,
  resumeInstance,
  waitUntilReady,
} from '../orchestrator.js';
import { config } from '../config.js';

const Query = z.object({ t: z.string().min(10) });

// Statuses where the existing container is still usable. Anything else means
// we must provision a fresh one for this launch.
const LIVE_STATUSES = new Set([
  'pending',
  'provisioning',
  'ready',
  'idle',
  'paused',
]);

/**
 * Browser-facing endpoints. No api-key auth — the signed JWT in the URL is
 * the authentication mechanism. The URL is REUSABLE within its `exp` window:
 * the same student can revisit it across days / devices / after clearing
 * cookies and be reconnected to (or reissued) their lab.
 *
 * Revocation: an admin can revoke an unredeemed (or any) launch by clearing
 * its `tokenJti`. This route refuses redemption when the stored jti doesn't
 * match the token's jti.
 */
export const redeemRoutes: FastifyPluginAsync = async (app) => {
  app.get('/launch/redeem', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) {
      reply.code(400);
      return { error: 'missing_token' };
    }

    let claims;
    try {
      claims = await verifyLaunchToken(q.data.t);
    } catch (err) {
      reply.code(401);
      return { error: 'invalid_token', detail: (err as Error).message };
    }

    const launch = await prisma.launch.findUnique({
      where: { id: claims.sub },
      include: { template: true, instance: true },
    });
    if (!launch) {
      reply.code(404);
      return { error: 'launch_not_found' };
    }

    // Revocation check: admins null `tokenJti` to revoke. A fresh URL has
    // tokenJti === claims.jti; a revoked one has tokenJti === null.
    if (launch.tokenJti !== claims.jti) {
      reply.code(401);
      return { error: 'token_revoked' };
    }

    // Server-side expiry guard (the JWT's own exp is already checked by
    // verifyLaunchToken, but launches can also be revoked-by-expiry).
    if (launch.expiresAt.getTime() <= Date.now()) {
      reply.code(401);
      return { error: 'launch_expired' };
    }

    // Reuse the existing instance if it is still alive; otherwise provision
    // a fresh one. This is what makes the URL reusable across days: a
    // reaped/terminated container is silently replaced.
    let instance = launch.instance;
    if (!instance || !LIVE_STATUSES.has(instance.status)) {
      try {
        instance = await acquireInstance({
          tenantId: launch.tenantId,
          template: launch.template,
          userIdHash: launch.userIdHash,
          durationMinutes: launch.durationMinutes,
          // Pin the container's lifetime to the URL's lifetime so the
          // student's lab (and persistent volume) stay until the batch is
          // over. Without this, the container would be reaped after
          // durationMinutes (≤ 8h) even though the URL is valid for 30 days.
          expiresAt: launch.expiresAt,
        });
      } catch (err) {
        reply.code(500);
        return { error: 'provision_failed', detail: (err as Error).message };
      }

      // Detach any stale instance pointer before attaching the new one —
      // `Launch.instanceId` is a unique column.
      await prisma.launch.update({
        where: { id: launch.id },
        data: {
          instanceId: instance.id,
          // First redeem stamps redeemedAt; subsequent ones leave it alone.
          redeemedAt: launch.redeemedAt ?? new Date(),
        },
      });
    } else if (!launch.redeemedAt) {
      // Instance already attached (e.g. created via a different path) but
      // first time we're recording the redemption.
      await prisma.launch.update({
        where: { id: launch.id },
        data: { redeemedAt: new Date() },
      });
    }

    // If the reaper had suspended the lab (cost saver), resume it now and
    // wait for the upstream to be reachable. The student should never see
    // a 502 immediately after redeeming.
    if (instance.status === 'paused' && instance.runtimeId) {
      try {
        instance = await resumeInstance(instance.id, {
          waitMs: config.RESUME_WAIT_TIMEOUT_SECONDS * 1000,
        });
      } catch (err) {
        reply.code(503);
        return { error: 'resume_failed', detail: (err as Error).message };
      }
    } else if (instance.runtimeId && instance.upstream) {
      // Freshly provisioned containers can take a few seconds to listen on
      // their port (Windows boot can take 30s+). Block briefly so the
      // redirect lands on a working URL.
      const ok = await waitUntilReady(
        instance.runtimeId,
        instance.upstream,
        config.RESUME_WAIT_TIMEOUT_SECONDS * 1000,
      );
      if (!ok) {
        // Still warming up. Render an HTML page that auto-refreshes so the
        // student sees a real status, not a JSON 502.
        const html = warmingUpHtml(launch.template.name);
        reply
          .code(202)
          .header('content-type', 'text/html; charset=utf-8')
          .send(html);
        return;
      }
    }

    const { token: sessionToken, expiresAt } = await signSessionToken({
      sub: instance.id,
      tenantId: launch.tenantId,
      userIdHash: launch.userIdHash,
    });

    const target = instanceUrl(instance.subdomain);
    // Cookie must be settable by the redeem endpoint's host AND readable by
    // the lab subdomain host. When redeem runs on api.<root> and labs live on
    // *.lab.<root>, the cookie must be scoped to the common parent <root>,
    // not to PUBLIC_LAB_DOMAIN (which would be a sibling subtree the redeem
    // host is not allowed to set cookies on).
    const cookieDomain = parentDomain(config.PUBLIC_LAB_DOMAIN);
    reply
      .setCookie('lf_session', sessionToken, {
        domain: cookieDomain,
        path: '/',
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        expires: expiresAt,
      })
      .redirect(target, 302);
  });
};

/** "lab.environments.learnlytica.com" → ".environments.learnlytica.com"
 *  "lab.localhost" → ".localhost"
 *  "localhost" → "localhost" (single label — used as-is)
 */
function parentDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length <= 1) return domain;
  return '.' + parts.slice(1).join('.');
}

/**
 * Branded "warming up" page. Auto-refreshes every 4s; the redirect happens
 * once the upstream is reachable. Stays HTML/200-ish so the browser doesn't
 * surface a scary error to the student.
 */
function warmingUpHtml(templateName: string): string {
  const safe = templateName.replace(/[<>&"']/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="4" />
  <title>Starting your lab… — LabForge</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      display: grid; place-items: center; min-height: 100vh; margin: 0;
      background: #0f172a; color: #e2e8f0;
    }
    .card {
      max-width: 480px; padding: 2.5rem; text-align: center;
      background: #1e293b; border: 1px solid #334155; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; font-weight: 600; }
    p { color: #94a3b8; margin: 0.25rem 0; font-size: 0.9rem; }
    .spinner {
      width: 36px; height: 36px; margin: 0 auto 1.5rem;
      border: 3px solid #334155; border-top-color: #38bdf8; border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    .tmpl { color: #38bdf8; font-weight: 500; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Starting your <span class="tmpl">${safe}</span> lab</h1>
    <p>This usually takes a few seconds.</p>
    <p>Windows labs can take up to a minute to wake up.</p>
    <p style="margin-top: 1.25rem; font-size: 0.75rem; opacity: 0.6;">
      This page refreshes automatically.
    </p>
  </div>
</body>
</html>`;
}
