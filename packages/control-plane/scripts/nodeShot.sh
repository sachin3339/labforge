#!/bin/bash
set -e
C=lab-d1e60idpqr1h
# python script that talks to QEMU monitor and screendumps
cat > /tmp/m.py <<'PYEOF'
import socket, time
s = socket.create_connection(("127.0.0.1", 7100), timeout=5)
time.sleep(0.5)
try:
    s.recv(4096)
except Exception:
    pass
s.sendall(b"screendump /tmp/shot.ppm\n")
time.sleep(3)
try:
    print(s.recv(4096).decode(errors="replace"))
except Exception as e:
    print("recv-fail", e)
s.close()
PYEOF
docker cp /tmp/m.py "$C":/tmp/m.py
docker exec "$C" python3 /tmp/m.py || echo "PY_FAIL"
docker exec "$C" ls -la /tmp/shot.ppm || echo "NO_PPM_IN_CONTAINER"
docker cp "$C":/tmp/shot.ppm /tmp/shot.ppm || echo "CP_FAIL"
ls -la /tmp/shot.ppm || echo "NO_PPM"
if [ -f /tmp/shot.ppm ]; then
  if command -v pnmtopng >/dev/null 2>&1; then pnmtopng /tmp/shot.ppm > /tmp/shot.png 2>/dev/null; fi
  if command -v convert >/dev/null 2>&1 && [ ! -f /tmp/shot.png ]; then convert /tmp/shot.ppm /tmp/shot.png 2>/dev/null; fi
  ls -la /tmp/shot.png 2>/dev/null || echo "NO_PNG_TOOL"
fi
