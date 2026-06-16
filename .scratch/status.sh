#!/bin/bash
sudo docker compose --env-file /opt/labforge/deploy/.env.prod -f /opt/labforge/deploy/docker-compose.prod.yml \
  exec -T postgres psql -U labforge -d labforge -tAc \
  "SELECT id, status, \"rdpHostPort\", \"createdAt\" FROM \"LabInstance\" WHERE \"templateId\"='cmpjhuiwz000al76a8r16auoa' AND status NOT IN ('terminated','failed') ORDER BY \"createdAt\" DESC LIMIT 5;"
echo
echo '--- recent control-plane logs ---'
sudo docker logs --since 2m deploy-control-plane-1 2>&1 | grep -iE 'rdp|ready|probe|provision' | tail -20
echo
echo '--- node-3 lab containers ---'
ssh -i /opt/labforge/deploy/secrets/nodes_id_ed25519 -o StrictHostKeyChecking=no root@80.243.180.81 'docker ps --filter name=lab- --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"'
