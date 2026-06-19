#!/bin/bash
set -e
SRC=/labforge/win-golden-builder/data.img
DST=/opt/labforge/win-golden/golden.img
echo "=== free space ==="
df -h /opt/labforge/win-golden /labforge | sed -n '1,4p'
echo "=== src info ==="
ls -la "$SRC"
qemu-img info "$SRC" 2>/dev/null | grep -iE 'file format|virtual size|disk size'
echo "=== making golden writable + starting sparse copy (detached) ==="
chmod u+w "$DST" 2>/dev/null || true
rm -f /opt/labforge/win-golden/.copy_done /opt/labforge/win-golden/recopy.log
setsid bash -c "cp --sparse=always '$SRC' '$DST' && chmod 0444 '$DST' && chown root:root '$DST' && touch /opt/labforge/win-golden/.copy_done" </dev/null >/opt/labforge/win-golden/recopy.log 2>&1 &
echo "copy started pid=$!"
