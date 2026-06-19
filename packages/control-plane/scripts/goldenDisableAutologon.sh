#!/usr/bin/env bash
# Build a writable copy of the Windows golden and disable console autologon
# (AutoAdminLogon=0, ForceAutoLogon=0, drop AutoLogonCount + DefaultPassword)
# so RDP creates the one-and-only session instead of taking over an existing
# auto-logged-in console session (which caused the "conflicts with another
# connection" kick). DefaultUserName=Docker is kept to pre-fill the login.
#
# Runs detached, writes /root/golden_noauto.status with progress.
set -euo pipefail
G=/opt/labforge/win-golden
SRC=$G/golden.img
NEW=$G/golden.img.new
ST=/root/golden_noauto.status

echo "START $(date -u +%H:%M:%S)" > "$ST"

# 1) writable sparse copy
rm -f "$NEW"
cp --sparse=always "$SRC" "$NEW"
echo "COPIED $(date -u +%H:%M:%S) size=$(du -h --apparent-size "$NEW" | cut -f1) used=$(du -h "$NEW" | cut -f1)" >> "$ST"

# 2) extract SOFTWARE hive from the copy
guestfish -a "$NEW" <<'GF'
run
mount /dev/sda3 /
download /Windows/System32/config/SOFTWARE /root/SOFTWARE.new.hive
GF
echo "EXTRACTED $(date -u +%H:%M:%S)" >> "$ST"

# 3) merge the autologon-off changes
cat > /root/noauto.reg <<'REG'
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon]
"AutoAdminLogon"="0"
"ForceAutoLogon"="0"
"AutoLogonCount"=-
"DefaultPassword"=-
REG
hivexregedit --merge --prefix 'HKEY_LOCAL_MACHINE\SOFTWARE' /root/SOFTWARE.new.hive /root/noauto.reg
echo "MERGED $(date -u +%H:%M:%S)" >> "$ST"

# 4) write the edited hive back into the copy
guestfish -a "$NEW" <<'GF'
run
mount /dev/sda3 /
upload /root/SOFTWARE.new.hive /Windows/System32/config/SOFTWARE
GF
echo "UPLOADED $(date -u +%H:%M:%S)" >> "$ST"

# 5) verify by re-reading from the copy
guestfish --ro -a "$NEW" <<'GF'
run
mount /dev/sda3 /
download /Windows/System32/config/SOFTWARE /root/SOFTWARE.verify.hive
GF
echo "===VERIFY===" >> "$ST"
hivexregedit --export /root/SOFTWARE.verify.hive 'Microsoft\Windows NT\CurrentVersion\Winlogon' \
  | grep -iE 'AutoAdminLogon|ForceAutoLogon|AutoLogonCount|DefaultPassword|DefaultUserName' >> "$ST" || true
echo "DONE $(date -u +%H:%M:%S)" >> "$ST"
