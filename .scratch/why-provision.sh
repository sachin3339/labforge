#!/bin/bash
set -u
cd /opt/labforge

echo '=== All Windows instances last 20 (including terminated) ==='
sudo docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml \
  exec -T postgres psql -U labforge -d labforge -c \
  "SELECT id, status, \"runtimeId\", \"rdpHostPort\", \"createdAt\", \"terminatedAt\" FROM \"LabInstance\" WHERE \"templateId\"='cmpjhuiwz000al76a8r16auoa' ORDER BY \"createdAt\" DESC LIMIT 20;"

echo
echo '=== Launches with current instanceId ==='
sudo docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml \
  exec -T postgres psql -U labforge -d labforge -c \
  "SELECT \"id\", \"instanceId\", \"redeemedAt\", \"expiresAt\", \"durationMinutes\" FROM \"Launch\" WHERE \"templateId\"='cmpjhuiwz000al76a8r16auoa' ORDER BY \"createdAt\" DESC LIMIT 10;"

echo
echo '=== Control-plane logs - look for reaper / destroy / idle ==='
sudo docker logs --since 15m deploy-control-plane-1 2>&1 | grep -iE 'reaper|idle|destroy|terminate|expired|provision|ready|probe|rdp' | tail -40
