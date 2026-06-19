#!/bin/bash
C=win-golden-builder
echo "=== waiting up to 180s for RDP 3389 to listen inside container ==="
ok=0
for i in $(seq 1 36); do
  if docker exec "$C" sh -lc "ss -tln 2>/dev/null | grep -q ':3389'"; then
    echo "RDP_LISTENING after ${i}x5s"
    ok=1
    break
  fi
  sleep 5
done
if [ "$ok" != "1" ]; then echo "RDP_NOT_LISTENING_AFTER_180s"; fi
echo "=== ss snapshot ==="
docker exec "$C" sh -lc "ss -tln 2>/dev/null | grep ':3389' || echo none"
echo "=== screendump ==="
cat > /tmp/m.py <<'PYEOF'
import socket, time
s = socket.create_connection(("127.0.0.1", 7100), timeout=5)
time.sleep(0.5)
try: s.recv(4096)
except Exception: pass
s.sendall(b"screendump /tmp/shot.ppm\n")
time.sleep(3)
s.close()
PYEOF
docker cp /tmp/m.py "$C":/tmp/m.py >/dev/null 2>&1
docker exec "$C" python3 /tmp/m.py >/dev/null 2>&1 || echo PY_FAIL
docker cp "$C":/tmp/shot.ppm /tmp/shot.ppm >/dev/null 2>&1 || echo CP_FAIL
if command -v pnmtopng >/dev/null 2>&1; then pnmtopng /tmp/shot.ppm > /tmp/shot.png 2>/dev/null; fi
ls -la /tmp/shot.png 2>/dev/null || echo NO_PNG
