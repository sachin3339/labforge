import { prisma } from './dist/db.js';

const tid = 'cmpjhuiwz000al76a8r16auoa';
const failed = await prisma.labInstance.findMany({
  where: { templateId: tid, status: 'failed' },
  select: { id: true, subdomain: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
});
console.log('FAILED_COUNT', failed.length);
for (const f of failed) console.log(' -', f.id, f.subdomain, f.createdAt.toISOString());

const ids = failed.map((f) => f.id);
// detach launches first (clear instanceId), then mark instances terminated
const upd = await prisma.launch.updateMany({
  where: { instanceId: { in: ids } },
  data: { instanceId: null },
});
console.log('LAUNCHES_DETACHED', upd.count);
const del = await prisma.labInstance.updateMany({
  where: { id: { in: ids } },
  data: { status: 'terminated', terminatedAt: new Date() },
});
console.log('INSTANCES_TERMINATED', del.count);
await prisma.$disconnect();
