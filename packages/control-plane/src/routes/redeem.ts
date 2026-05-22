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
    reply
      .setCookie('lf_session', sessionToken, {
        domain: `.${config.PUBLIC_LAB_DOMAIN}`,
        path: '/',
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        expires: expiresAt,
      })
      .redirect(target, 302);
  });
};
