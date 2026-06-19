import { prisma } from './dist/db.js';
const me = await prisma.labInstance.findUnique({ where: { id: 'cmqhvuivc000lf9zoukzohbxo' }, select: { batchId: true } });
const ins = await prisma.labInstance.findMany({ where: { batchId: me.batchId }, select: { id: true, subdomain: true, status: true }, orderBy: { createdAt: 'asc' } });
console.log(JSON.stringify(ins));
process.exit(0);
