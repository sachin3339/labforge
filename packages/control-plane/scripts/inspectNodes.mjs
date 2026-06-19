import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

console.log('=== NODES ===');
const nodes = await prisma.node.findMany({
  select: { id: true, name: true, enabled: true, isDefault: true, connectionMode: true, sshHost: true, bindIp: true, capacityMax: true, lastSeenAt: true, lastError: true, _count: { select: { instances: true } } },
});
for (const n of nodes) {
  console.log(
    n.name.padEnd(14),
    'enabled=' + n.enabled,
    'default=' + n.isDefault,
    'mode=' + (n.connectionMode ?? '-'),
    'host=' + (n.sshHost ?? '-'),
    'capMax=' + (n.capacityMax ?? '-'),
    'instances=' + n._count.instances,
    'seen=' + (n.lastSeenAt ? n.lastSeenAt.toISOString().slice(5, 19) : '-'),
    'err=' + (n.lastError ?? '-'),
  );
}

console.log('\n=== NON-TERMINATED LINUX-DESKTOP / UBUNTU INSTANCES ===');
const insts = await prisma.labInstance.findMany({
  where: { status: { notIn: ['terminated', 'failed'] } },
  orderBy: { createdAt: 'desc' },
  select: {
    id: true, status: true, createdAt: true, lastSeenAt: true,
    subdomain: true, runtimeId: true, upstream: true,
    template: { select: { name: true, spec: true } },
    node: { select: { name: true } },
  },
  take: 60,
});
for (const i of insts) {
  const rt = i.template?.spec?.runtime;
  console.log(
    i.status.padEnd(13),
    (i.template?.name ?? '?').padEnd(15),
    'node=' + (i.node?.name ?? '-').padEnd(10),
    'sub=' + (i.subdomain ?? '-').padEnd(14),
    'up=' + (i.upstream ?? '-').padEnd(22),
    'seen=' + (i.lastSeenAt ? i.lastSeenAt.toISOString().slice(11,19) : '-'),
    'created=' + i.createdAt.toISOString().slice(5,19),
  );
}
console.log('total non-terminated:', insts.length);

await prisma.$disconnect();
