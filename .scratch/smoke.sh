#!/bin/bash
set -u
cd /opt/labforge
KEY=$(grep ^SEED_TENANT_API_KEY deploy/.env.prod | cut -d= -f2)
TPL=cmpjhuiwz000al76a8r16auoa
API=https://api.environments.learnlytica.com/api/v1

psql() {
  sudo docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml \
    exec -T postgres psql -U labforge -d labforge -tAc "$1"
}

echo '=== BASELINE: ready Windows instances ==='
psql "SELECT count(*) FROM \"LabInstance\" WHERE \"templateId\"='$TPL' AND status='ready';"

echo
echo '=== Issuing 5 fresh launches (distinct studentIds) ==='
URLS=()
for i in 1 2 3 4 5; do
  STUDENT_ID="smoke-$i-$(date +%s%N)"
  RESP=$(curl -sS -X POST "$API/launches" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"templateId\":\"$TPL\",\"userId\":\"$STUDENT_ID\",\"userDisplayName\":\"Smoke $i\",\"durationMinutes\":120}")
  URL=$(echo "$RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("launchUrl") or d)')
  echo "  STUDENT $i -> $URL"
  URLS+=("$URL")
done

echo
echo '=== Wait for instances to become ready (poll up to 180s) ==='
for n in $(seq 1 36); do
  R=$(psql "SELECT count(*) FROM \"LabInstance\" WHERE \"templateId\"='$TPL' AND status='ready';")
  echo "  t=${n}*5s ready=$R"
  if [ "$R" -ge 5 ]; then break; fi
  sleep 5
done

echo
echo '=== DB view: distinct guacamoleUser per instance ==='
psql "SELECT id, status, \"guacamoleUser\", \"rdpHostPort\", \"vmOverlayPath\" FROM \"LabInstance\" WHERE \"templateId\"='$TPL' AND status='ready' ORDER BY \"createdAt\" DESC LIMIT 10;"

echo
echo '=== user-mapping.xml authorize blocks ==='
sudo docker exec deploy-guacamole-1 grep -c '<authorize' /home/guacamole/.guacamole/user-mapping.xml
sudo docker exec deploy-guacamole-1 grep -oP 'username="lab-[^"]+"' /home/guacamole/.guacamole/user-mapping.xml

echo
echo '=== Node-3 containers + overlay sizes (isolation check) ==='
ssh -i deploy/secrets/nodes_id_ed25519 -o StrictHostKeyChecking=no root@80.243.180.81 \
  'docker ps --filter name=lab- --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"; echo --- overlays ---; ls /opt/labforge/instances/; echo --- sizes ---; du -sh /opt/labforge/instances/*/disk.qcow2 2>/dev/null'

echo
echo '=== Tracing first redeem URL through HTTP redirect chain ==='
echo "TRACE: ${URLS[0]}"
curl -sS -L -o /dev/null -w 'HTTP %{http_code}  final=%{url_effective}\n' "${URLS[0]}"

echo
echo '=== STUDENT URLS (open each in incognito) ==='
for u in "${URLS[@]}"; do echo "  $u"; done
