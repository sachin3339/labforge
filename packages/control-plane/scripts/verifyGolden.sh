#!/bin/bash
set -e
G=/opt/labforge/win-golden/golden.img
echo "=== golden info ==="
qemu-img info "$G"
echo "=== lock perms 0444 ==="
chmod 0444 "$G"; chown root:root "$G"; ls -la "$G"
echo "=== overlay smoke test ==="
cd /tmp
rm -f smoke.qcow2
qemu-img create -f qcow2 -b "$G" -F raw smoke.qcow2 64G >/dev/null
qemu-img info smoke.qcow2 | grep -iE 'backing file|file format'
qemu-img check smoke.qcow2 2>&1 | tail -2
rm -f smoke.qcow2
echo "=== golden dir ==="
ls -la /opt/labforge/win-golden/*.img
