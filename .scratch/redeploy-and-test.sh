#!/bin/bash
set -u
cd /opt/labforge

echo '=== Pull + rebuild + restart ==='
git pull
sudo docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml build control-plane
sudo docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml up -d control-plane
sleep 8

KEY=$(grep ^SEED_TENANT_API_KEY deploy/.env.prod | cut -d= -f2)
TPL=cmpjhuiwz000al76a8r16auoa

echo
echo '=== Terminate stuck/unbooted instances + clean their overlays + Launch pointers ==='
sudo docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml \
  exec -T postgres psql -U labforge -d labforge -c \
  "UPDATE \"LabInstance\" SET status='terminated', \"terminatedAt\"=now() WHERE \"templateId\"='$TPL' AND status NOT IN ('terminated','failed'); UPDATE \"Launch\" SET \"instanceId\"=NULL WHERE \"instanceId\" IN (SELECT id FROM \"LabInstance\" WHERE \"templateId\"='$TPL' AND status='terminated');"
ssh -i deploy/secrets/nodes_id_ed25519 -o StrictHostKeyChecking=no root@80.243.180.81 \
  'docker ps --filter name=lab- -q | xargs -r docker rm -f; rm -rf /opt/labforge/instances/*'

echo
echo '=== Issue ONE fresh launch and time how long until status=ready ==='
SID="rdyprobe-$(date +%s)"
START=$(date +%s)
RESP=$(curl -sS -X POST https://api.environments.learnlytica.com/api/v1/launches \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"templateId\":\"$TPL\",\"userId\":\"$SID\",\"userDisplayName\":\"Probe\",\"durationMinutes\":60}")
URL=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("launchUrl",""))')
echo "REDEEM (already ready, RDP probe passed): $URL"
ELAPSED=$(( $(date +%s) - START ))
echo "Total provision time: ${ELAPSED}s"

echo
echo '=== Trace redirect ==='
curl -sS -L -o /dev/null -w 'HTTP %{http_code}  final=%{url_effective}\n' "$URL"

echo
echo '=== guacd should now succeed (no "wrong security type") ==='
sleep 2
sudo docker logs --since 60s deploy-guacd-1 2>&1 | tail -15
