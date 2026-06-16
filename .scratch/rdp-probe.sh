#!/bin/bash
set -u
echo '=== Test RDP from inside Node-3 to one VM ==='
ssh -i /opt/labforge/deploy/secrets/nodes_id_ed25519 -o StrictHostKeyChecking=no root@80.243.180.81 'bash -s' <<'NODESH'
set -u
echo '--- xfreerdp probe (from host, security=any vs rdp vs tls vs nla) ---'
which xfreerdp || apt-get install -y freerdp2-x11 >/dev/null 2>&1 || apt-get install -y freerdp3-x11 >/dev/null 2>&1
which xfreerdp
PORT=$(docker ps --filter name=lab- --format '{{.Ports}}' | head -1 | grep -oP '0\.0\.0\.0:\K[0-9]+(?=->3389)' | head -1)
echo "Probing port=$PORT on 127.0.0.1"
for SEC in rdp tls nla any; do
  echo "--- security=$SEC ---"
  timeout 8 xfreerdp /v:127.0.0.1:$PORT /u:Docker /p:'LabPass#1' /sec:$SEC /cert-ignore +auth-only 2>&1 | tail -8
done

echo
echo '--- ss listen ---'
ss -tlnp | grep ":$PORT"

echo
echo '--- one VM container logs (recent boot/RDP messages) ---'
NAME=$(docker ps --filter name=lab- --format '{{.Names}}' | head -1)
echo "Container: $NAME"
docker logs --tail 30 "$NAME" 2>&1 | grep -iE 'rdp|boot|ready|listening' | tail -20

echo
echo '--- Check Windows boot status via 8006 noVNC port (HTTP head) ---'
NOVNC=$(docker ps --filter name=$NAME --format '{{.Ports}}' | grep -oP '0\.0\.0\.0:\K[0-9]+(?=->8006)')
echo "noVNC port: $NOVNC"
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:$NOVNC/ || true
NODESH
