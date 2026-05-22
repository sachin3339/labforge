import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { verifyLaunchToken, signSessionToken } from '../auth/jwt.js';
import { acquireInstance, instanceUrl } from '../orchestrator.js';
import { config } from '../config.js';

const Query = z.object({ t: z.string().min(10) });

/**
 * Browser-facing endpoints. No api-key auth — the JWT in the URL is the
 * authentication mechanism (single-use, short-lived).
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

    // Atomic single-use redemption. UPDATE ... WHERE tokenJti=? AND redeemedAt
    // IS NULL guarantees only one request wins.
    const claimed = await prisma.launch.updateMany({
      where: { id: claims.sub, tokenJti: claims.jti, redeemedAt: null },
      data: { redeemedAt: new Date() },
    });
    if (claimed.count === 0) {
      reply.code(409);
      return { error: 'token_already_used_or_unknown' };
    }

    const launch = await prisma.launch.findUniqueOrThrow({
      where: { id: claims.sub },
      include: { template: true },
    });

    let instance;
    try {
      instance = await acquireInstance({
        tenantId: launch.tenantId,
        template: launch.template,
        userIdHash: launch.userIdHash,
        durationMinutes: launch.durationMinutes,
      });
    } catch (err) {
      reply.code(500);
      return { error: 'provision_failed', detail: (err as Error).message };
    }

    await prisma.launch.update({
      where: { id: launch.id },
      data: { instanceId: instance.id, tokenJti: null },
    });

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
