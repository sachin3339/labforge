import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import type {
  LaunchTokenClaims,
  SessionTokenClaims,
} from '@labforge/shared';
import { config, decodeB64 } from '../config.js';

const ALG = 'RS256';

const privateKey = await importPKCS8(decodeB64(config.JWT_PRIVATE_KEY_B64), ALG);
const publicKey = await importSPKI(decodeB64(config.JWT_PUBLIC_KEY_B64), ALG);

/** Hash a user identifier so we never store the raw LMS user id. */
export function hashUserId(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export async function signLaunchToken(
  payload: Omit<LaunchTokenClaims, 'iss' | 'iat' | 'exp' | 'aud'>,
  opts: { ttlSeconds?: number } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? config.JWT_LAUNCH_TTL_SECONDS;
  const exp = now + ttl;
  const token = await new SignJWT({
    tenantId: payload.tenantId,
    templateId: payload.templateId,
    userIdHash: payload.userIdHash,
  })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience('labforge:launch')
    .setSubject(payload.sub)
    .setJti(payload.jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyLaunchToken(token: string): Promise<LaunchTokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.JWT_ISSUER,
    audience: 'labforge:launch',
  });
  return payload as unknown as LaunchTokenClaims;
}

export async function signSessionToken(
  payload: Omit<SessionTokenClaims, 'iss' | 'iat' | 'exp' | 'aud'>,
): Promise<{ token: string; expiresAt: Date }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.JWT_SESSION_TTL_SECONDS;
  const token = await new SignJWT({
    tenantId: payload.tenantId,
    userIdHash: payload.userIdHash,
  })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience('labforge:session')
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifySessionToken(token: string): Promise<SessionTokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.JWT_ISSUER,
    audience: 'labforge:session',
  });
  return payload as unknown as SessionTokenClaims;
}
