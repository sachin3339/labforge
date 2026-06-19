#!/usr/bin/env bash
set -e
echo "--- triggering regen #1 ---"
sudo docker exec -w /app/packages/control-plane deploy-control-plane-1 \
  node --input-type=module -e "import {prisma} from './dist/db.js'; import {regenerateUserMapping} from './dist/runtime/guacamole.js'; const r = await regenerateUserMapping(prisma); console.log('regen='+JSON.stringify(r)); process.exit(0);" 2>&1 | grep -i regen || true
echo "--- ids after regen #1 ---"
sudo docker exec deploy-postgres-1 psql -U labforge -d guacamole_db -c "SELECT connection_id, connection_name FROM guacamole_connection ORDER BY connection_id;"
echo "--- triggering regen #2 ---"
sudo docker exec -w /app/packages/control-plane deploy-control-plane-1 \
  node --input-type=module -e "import {prisma} from './dist/db.js'; import {regenerateUserMapping} from './dist/runtime/guacamole.js'; const r = await regenerateUserMapping(prisma); console.log('regen='+JSON.stringify(r)); process.exit(0);" 2>&1 | grep -i regen || true
echo "--- ids after regen #2 (must match snapshot) ---"
sudo docker exec deploy-postgres-1 psql -U labforge -d guacamole_db -c "SELECT connection_id, connection_name FROM guacamole_connection ORDER BY connection_id;"
