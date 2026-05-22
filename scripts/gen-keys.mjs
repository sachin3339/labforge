/**
 * Generate an RS256 keypair and print the base64 lines to paste into .env.
 * Usage: node scripts/gen-keys.mjs >> .env
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
process.stdout.write(`JWT_PRIVATE_KEY_B64=${enc(privateKey)}\n`);
process.stdout.write(`JWT_PUBLIC_KEY_B64=${enc(publicKey)}\n`);
