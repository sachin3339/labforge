#!/usr/bin/env bash
set -e
INST="cmqhvuivc000lf9zoukzohbxo"   # test-4-win seat 4, connection_id 9
CID="9"

# Pull the instance's guac user + (plaintext) guac password from the
# control-plane DB via prisma, inside the container.
CREDS=$(sudo docker exec -w /app/packages/control-plane deploy-control-plane-1 \
  node --input-type=module -e "
import {prisma} from './dist/db.js';
const i = await prisma.labInstance.findUnique({ where: { id: '$INST' }, select: { guacamoleUser: true, guacamolePassword: true } });
process.stdout.write((i?.guacamoleUser||'')+'\\n'+(i?.guacamolePassword||''));
process.exit(0);
" 2>/dev/null)

GUSER=$(printf '%s' "$CREDS" | sed -n '1p')
GPASS=$(printf '%s' "$CREDS" | sed -n '2p')
echo "probe user=$GUSER passlen=${#GPASS} cid=$CID"

# Copy the probe into the container's package tree (so `import 'undici'` resolves).
sudo docker cp /tmp/kp.mjs deploy-control-plane-1:/app/packages/control-plane/kp.mjs

echo "--- running keyboard probe ---"
sudo docker exec -w /app/packages/control-plane \
  -e GUSER="$GUSER" -e GPASS="$GPASS" -e CID="$CID" \
  deploy-control-plane-1 node kp.mjs

echo "--- guacd tail during probe ---"
sudo docker logs deploy-guacd-1 --tail 12 2>&1
