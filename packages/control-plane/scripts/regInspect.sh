#!/bin/bash
set -e
D=/labforge/win-golden-builder/data.img
W=/tmp/reg
rm -rf "$W"; mkdir -p "$W"
echo "=== downloading hives (ro) ==="
guestfish --ro -a "$D" run : mount /dev/sda3 / : download /Windows/System32/config/SYSTEM "$W/SYSTEM"
guestfish --ro -a "$D" run : mount /dev/sda3 / : download /Windows/System32/config/SOFTWARE "$W/SOFTWARE"
ls -la "$W"
echo "=== which hive tools ==="
which hivexget hivexregedit 2>&1 || true
echo "=== Select\\Current ==="
hivexget "$W/SYSTEM" 'Select' Current 2>&1 || echo "hivexget-select-failed"
echo "=== ControlSet001 Terminal Server fDenyTSConnections ==="
hivexget "$W/SYSTEM" 'ControlSet001\Control\Terminal Server' fDenyTSConnections 2>&1 || echo "none"
echo "=== ControlSet001 TermService Start ==="
hivexget "$W/SYSTEM" 'ControlSet001\Services\TermService' Start 2>&1 || echo "none"
echo "=== Winlogon AutoAdminLogon ==="
hivexget "$W/SOFTWARE" 'Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon 2>&1 || echo "none"
echo "=== Winlogon DefaultUserName ==="
hivexget "$W/SOFTWARE" 'Microsoft\Windows NT\CurrentVersion\Winlogon' DefaultUserName 2>&1 || echo "none"
echo "=== Winlogon DefaultPassword ==="
hivexget "$W/SOFTWARE" 'Microsoft\Windows NT\CurrentVersion\Winlogon' DefaultPassword 2>&1 || echo "none"
