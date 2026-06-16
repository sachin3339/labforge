#!/bin/bash
set -u
cd /opt/labforge
KEY=$(grep ^SEED_TENANT_API_KEY deploy/.env.prod | cut -d= -f2)
TPL=cmpjhuiwz000al76a8r16auoa

psql() {
  sudo docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml \
    exec -T postgres psql -U labforge -d labforge -tAc "$1"
}

echo '=== DB: ready instances + guac users ==='
psql "SELECT id, status, \"guacamoleUser\", \"rdpHostPort\" FROM \"LabInstance\" WHERE \"templateId\"='$TPL' AND status='ready' ORDER BY \"createdAt\" DESC;"

echo
echo '=== user-mapping.xml authorize count + users ==='
sudo docker exec deploy-guacamole-1 grep -c '<authorize' /home/guacamole/.guacamole/user-mapping.xml
sudo docker exec deploy-guacamole-1 grep -oP 'username="lab-[^"]+"' /home/guacamole/.guacamole/user-mapping.xml

echo
echo '=== symlink check ==='
sudo docker exec deploy-guacamole-1 ls -la /home/guacamole/.guacamole/user-mapping.xml
sudo ls -la /opt/labforge/deploy/guacamole/user-mapping.xml

echo
echo '=== Force regen + show resulting count ==='
curl -sS -X POST https://api.environments.learnlytica.com/api/v1/platform/guacamole/resync \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}'
echo
sudo docker exec deploy-guacamole-1 grep -c '<authorize' /home/guacamole/.guacamole/user-mapping.xml

echo
echo '=== Issue ONE fresh launch + trace through redirect ==='
SID="diag-$(date +%s%N)"
RESP=$(curl -sS -X POST https://api.environments.learnlytica.com/api/v1/launches \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"templateId\":\"$TPL\",\"userId\":\"$SID\",\"userDisplayName\":\"Diag\",\"durationMinutes\":60}")
echo "RAW: $RESP"
URL=$(echo "$RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("launchUrl",""))')
echo
echo "REDEEM: $URL"
echo
echo '=== Trace redirect chain ==='
curl -sS -L -o /dev/null -w 'HTTP %{http_code}  redirect_count=%{num_redirects}  final=%{url_effective}\n' "$URL"
echo
echo '=== Guacamole login attempt for that URL (extracted creds) ==='
FINAL=$(curl -sS -L -o /dev/null -w '%{url_effective}' "$URL")
echo "FINAL: $FINAL"
USER=$(echo "$FINAL" | sed -n 's/.*username=\([^&]*\).*/\1/p')
PASS=$(echo "$FINAL" | sed -n 's/.*password=\([^&]*\).*/\1/p')
echo "USER=$USER  PASS=$PASS"
echo
echo "Is this user in user-mapping?"
sudo docker exec deploy-guacamole-1 grep -F "username=\"$USER\"" /home/guacamole/.guacamole/user-mapping.xml || echo 'NOT FOUND'

echo
echo '=== guacd recent errors ==='
sudo docker logs --tail 30 deploy-guacd-1 2>&1 | tail -20
