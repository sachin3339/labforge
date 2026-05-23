/**
 * Seed the platform tenant and re-apply the standard catalog on every
 * control-plane start (idempotent). Template specs are upserted so spec
 * changes ship via the normal deploy.
 *
 * The catalog itself lives in `src/catalog/defaults.ts` and is also used
 * by tenant creation so every new client gets the same lineup.
 */
import { PrismaClient } from '@prisma/client';
import { provisionDefaultCatalog } from '../src/catalog/defaults.js';

const prisma = new PrismaClient();

async function main() {
  const tenantName = process.env.SEED_TENANT_NAME ?? 'Demo Trainers';
  const apiKey = process.env.SEED_TENANT_API_KEY ?? 'dev-api-key-change-me';

  const tenant = await prisma.tenant.upsert({
    where: { apiKey },
    update: { name: tenantName, role: 'platform' },
    create: { name: tenantName, apiKey, role: 'platform' },
  });

  // Platform tenant always tracks the latest catalog spec.
  await provisionDefaultCatalog(prisma, tenant.id, 'upsert');

  // eslint-disable-next-line no-console
  console.log(`Seeded tenant "${tenant.name}" (apiKey=${apiKey})`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
