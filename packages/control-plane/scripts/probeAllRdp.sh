#!/bin/bash
# Probe RDP (X.224) on every running lab-* container's guest at 20.20.20.21:3389
cat > /tmp/p.py <<'PYEOF'
import socket,sys
host="20.20.20.21"; port=3389
try:
    s=socket.create_connection((host,port),timeout=8); s.settimeout(8)
    s.sendall(bytes.fromhex("030000130ee00000000000010008000b000000"))
    d=s.recv(64)
    print("RDP_OK", len(d))
except Exception as e:
    print("RDP_FAIL", type(e).__name__)
PYEOF
for C in $(docker ps --filter name=lab- --format '{{.Names}}' | sort); do
  docker cp /tmp/p.py "$C":/tmp/p.py >/dev/null 2>&1
  R=$(docker exec "$C" python3 /tmp/p.py 2>/dev/null || echo "NO_PY")
  printf '%-22s %s\n' "$C" "$R"
done
