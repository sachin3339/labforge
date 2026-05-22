import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import type { Tenant } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
  }
}

/**
 * Authenticate LMS-facing requests by `Authorization: Bearer <apiKey>` or
 * `X-Api-Key`. The api key uniquely identifies a tenant.
 */
export async function authenticateTenant(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization;
  const apiKey =
    (header?.startsWith('Bearer ') ? header.slice(7) : undefined) ??
    (req.headers['x-api-key'] as string | undefined);

  if (!apiKey) {
    reply.code(401).send({ error: 'missing_api_key' });
    return;
  }

  const tenant = await prisma.tenant.findUnique({ where: { apiKey } });
  if (!tenant) {
    reply.code(401).send({ error: 'invalid_api_key' });
    return;
  }

  req.tenant = tenant;
}
