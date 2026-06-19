#!/bin/bash
set -e
D=/labforge/win-golden-builder/data.img
W=/tmp/reg
cp "$W/SYSTEM" "$W/SYSTEM.bak"
cp "$W/SOFTWARE" "$W/SOFTWARE.bak"

cat > "$W/system.reg" <<'EOF'
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SYSTEM\ControlSet001\Control\Terminal Server]
"fDenyTSConnections"=dword:00000000

[HKEY_LOCAL_MACHINE\SYSTEM\ControlSet001\Control\Terminal Server\WinStations\RDP-Tcp]
"UserAuthentication"=dword:00000001

[HKEY_LOCAL_MACHINE\SYSTEM\ControlSet001\Services\TermService]
"Start"=dword:00000002

[HKEY_LOCAL_MACHINE\SYSTEM\ControlSet001\Services\SharedAccess\Parameters\FirewallPolicy\StandardProfile]
"EnableFirewall"=dword:00000000

[HKEY_LOCAL_MACHINE\SYSTEM\ControlSet001\Services\SharedAccess\Parameters\FirewallPolicy\DomainProfile]
"EnableFirewall"=dword:00000000

[HKEY_LOCAL_MACHINE\SYSTEM\ControlSet001\Services\SharedAccess\Parameters\FirewallPolicy\PublicProfile]
"EnableFirewall"=dword:00000000
EOF

cat > "$W/software.reg" <<'EOF'
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon]
"AutoAdminLogon"="1"
"DefaultUserName"="Docker"
"DefaultPassword"="LabPass#1"
"DefaultDomainName"="."
"ForceAutoLogon"="1"
EOF

echo "=== merge SYSTEM ==="
hivexregedit --merge --prefix 'HKEY_LOCAL_MACHINE\SYSTEM' "$W/SYSTEM" "$W/system.reg" && echo "system-merge-ok"
echo "=== merge SOFTWARE ==="
hivexregedit --merge --prefix 'HKEY_LOCAL_MACHINE\SOFTWARE' "$W/SOFTWARE" "$W/software.reg" && echo "software-merge-ok"

echo "=== verify SYSTEM ==="
hivexregedit --export "$W/SYSTEM" 'ControlSet001\Control\Terminal Server' | grep -i fDeny
hivexregedit --export "$W/SYSTEM" 'ControlSet001\Services\TermService' | grep -i '"Start"'
hivexregedit --export "$W/SYSTEM" 'ControlSet001\Control\Terminal Server\WinStations\RDP-Tcp' | grep -i UserAuth
echo "=== verify SOFTWARE ==="
hivexregedit --export "$W/SOFTWARE" 'Microsoft\Windows NT\CurrentVersion\Winlogon' | grep -iE 'AutoAdminLogon|DefaultPassword|ForceAutoLogon'

echo "=== upload back (RW) ==="
guestfish --rw -a "$D" run : mount /dev/sda3 / : upload "$W/SYSTEM" /Windows/System32/config/SYSTEM : upload "$W/SOFTWARE" /Windows/System32/config/SOFTWARE
echo "UPLOAD_DONE rc=$?"
