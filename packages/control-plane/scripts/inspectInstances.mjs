import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const templates = await prisma.labTemplate.findMany({
  select: { id: true, name: true, spec: true },
});
console.log('=== TEMPLATES ===');
for (const t of templates) {
  const spec = t.spec ?? {};
  console.log(t.id, '|', t.name, '| runtime=', spec.runtime, '| image=', spec.image ?? spec.dockerImage);
}

console.log('\n=== RECENT INSTANCES (last 90 min) ===');
const since = new Date(Date.now() - 90 * 60 * 1000);
const insts = await prisma.labInstance.findMany({
  where: { createdAt: { gt: since } },
  orderBy: { createdAt: 'desc' },
  select: {
    id: true, status: true, createdAt: true, lastSeenAt: true,
    subdomain: true, runtimeId: true, upstream: true,
    template: { select: { name: true } },
    node: { select: { name: true } },
  },
  take: 40,
});
for (const i of insts) {
  console.log(
    i.status.padEnd(13),
    (i.template?.name ?? '?').padEnd(14),
    i.subdomain ?? '-',
    'node=' + (i.node?.name ?? '-'),
    'up=' + (i.upstream ?? '-'),
    i.createdAt.toISOString().slice(11, 19),
  );
}
console.log('total recent:', insts.length);

const byStatus = await prisma.labInstance.groupBy({
  by: ['status'],
  _count: true,
  where: { createdAt: { gt: since } },
});
console.log('\n=== STATUS COUNTS (last 90m) ===');
for (const s of byStatus) console.log(s.status, s._count);

await prisma.$disconnect();
