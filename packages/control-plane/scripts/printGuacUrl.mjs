import { prisma } from './dist/db.js';
import { getGuacConnectionId, guacamoleClientUrlJdbc } from './dist/runtime/guacamoleJdbc.js';
import { instanceUrl } from './dist/orchestrator.js';
const inst = process.argv[2] || 'cmqhvuivc000lf9zoukzohbxo';
const i = await prisma.labInstance.findUnique({
  where: { id: inst },
  select: { subdomain: true, guacamoleUser: true, guacamolePassword: true },
});
const cid = await getGuacConnectionId(inst);
const base = instanceUrl(i.subdomain);
console.log('subdomain :', i.subdomain);
console.log('origin    :', base);
console.log('cid       :', cid);
console.log('url       :', guacamoleClientUrlJdbc(base, i.guacamoleUser, i.guacamolePassword, cid));
process.exit(0);
