#!/bin/bash
W=/tmp/reg
echo "=== Select ==="
hivexregedit --export "$W/SYSTEM" 'Select' 2>&1 | grep -iE 'Current|Default' || echo none
echo "=== TS root (CS001) ==="
hivexregedit --export "$W/SYSTEM" 'ControlSet001\Control\Terminal Server' 2>&1 | grep -i fDenyTSConnections || echo none
echo "=== RDP-Tcp (CS001) ==="
hivexregedit --export "$W/SYSTEM" 'ControlSet001\Control\Terminal Server\WinStations\RDP-Tcp' 2>&1 | grep -iE 'UserAuthentication|SecurityLayer' || echo none
echo "=== TermService Start (CS001) ==="
hivexregedit --export "$W/SYSTEM" 'ControlSet001\Services\TermService' 2>&1 | grep -i '"Start"' || echo none
echo "=== Winlogon ==="
hivexregedit --export "$W/SOFTWARE" 'Microsoft\Windows NT\CurrentVersion\Winlogon' 2>&1 | grep -iE 'AutoAdminLogon|DefaultUserName|DefaultPassword|DefaultDomainName|ForceAutoLogon' || echo none
