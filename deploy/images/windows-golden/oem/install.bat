@echo off
:: ===================================================================
:: LabForge Windows-11 golden-image OEM provisioner (dockur hook)
:: ===================================================================
:: dockur/windows copies the contents of a host folder mounted at
:: /oem into C:\OEM inside the guest and runs install.bat ONCE, during
:: the first-logon phase of Windows Setup. We use that hook to install
:: the full LabForge student toolchain unattended, then the operator
:: snapshots the disk into the read-only golden image.
::
:: Everything heavy lives in provision.ps1 so it can also be re-run by
:: hand over RDP/noVNC if the first-boot pass is interrupted.
:: ===================================================================

echo [LabForge] OEM install.bat starting %DATE% %TIME%

:: Run the PowerShell provisioner with an unrestricted policy for this
:: process only. Output is teed to C:\OEM\provision.log for debugging.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0provision.ps1" *>> "%~dp0provision.log"

echo [LabForge] OEM install.bat finished %DATE% %TIME%
exit /b 0
