#!/bin/bash
C=win-golden-builder
echo "=== guest IP / arp ==="
docker exec "$C" sh -lc "ip -4 addr show qemu 2>/dev/null | grep inet; echo ---; arp -an 2>/dev/null | head; echo ---; cat /var/lib/misc/dnsmasq.leases 2>/dev/null; cat /run/dnsmasq.leases 2>/dev/null"
echo "=== probe guest RDP on 20.20.20.21:3389 (X.224) ==="
cat > /tmp/p.py <<'PYEOF'
import socket
host="20.20.20.21"; port=3389
try:
    s=socket.create_connection((host,port),timeout=8); s.settimeout(8)
    s.sendall(bytes.fromhex("030000130ee00000000000010008000b000000"))
    d=s.recv(64)
    print("RDP_X224_REPLY_LEN", len(d))
    s.close()
except Exception as e:
    print("PROBE_FAIL", type(e).__name__, str(e)[:120])
PYEOF
docker cp /tmp/p.py "$C":/tmp/p.py >/dev/null
docker exec "$C" python3 /tmp/p.py
echo "=== also try connect-test to 3389 ==="
docker exec "$C" sh -lc "timeout 5 sh -c 'echo > /dev/tcp/20.20.20.21/3389' 2>/dev/null && echo TCP_OPEN || echo TCP_REFUSED_OR_TIMEOUT"
