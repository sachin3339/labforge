#!/bin/bash
echo "===BEFORE==="
docker ps -a --filter name=lab- --format '{{.Names}}'
for c in $(docker ps -a --filter name=lab- --format '{{.Names}}'); do
  d=$(docker inspect "$c" --format '{{ range .Mounts }}{{ if eq .Destination "/storage" }}{{ .Source }}{{ end }}{{ end }}')
  docker rm -f "$c" >/dev/null 2>&1
  echo "removed $c dir=$d"
  if [ -n "$d" ] && [ -d "$d" ]; then rm -rf "$d"; fi
done
echo "===REMAINING_CONTAINERS==="
docker ps -a --filter name=lab- -q | wc -l
echo "===INSTANCE_DIRS_LEFT==="
ls /opt/labforge/instances 2>/dev/null | wc -l
