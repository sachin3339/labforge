<#
.SYNOPSIS
  LabForge Windows-11 golden-image software provisioner.

.DESCRIPTION
  Installs the full LabForge student toolchain into a Windows 11 guest:

    - Python 3.12  (machine scope, PATH + pip)
    - Jupyter      (notebook + jupyterlab, via pip on Python 3.12)
    - MySQL Server 8.0
    - MySQL Workbench 8.0
    - Git           (Git Bash)
    - Postman
    - MongoDB Server
    - MongoDB Compass
    - Visual Studio Code

  Primary install path is winget (App Installer), which ships with
  Windows 11 and is fully reliable in an interactive admin session -
  exactly how the golden image is built (operator connects over
  noVNC/RDP). Each package is installed with the agreement flags
  pre-accepted so the run is unattended, and each step is retried.

  This script is invoked automatically by install.bat via dockur's
  /oem first-boot hook, and is ALSO safe to run by hand:

      powershell -ExecutionPolicy Bypass -File C:\OEM\provision.ps1

  It is idempotent: winget skips packages already present, and the
  pip / RDP / log steps are no-ops on a second pass.
#>

$ErrorActionPreference = 'Continue'
$ProgressPreference     = 'SilentlyContinue'   # speeds up Invoke-WebRequest

function Write-Step {
    param([string]$Message)
    Write-Host ("[LabForge] {0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

# ------------------------------------------------------------------
# Locate winget.exe. In some first-logon contexts it isn't on PATH
# yet even though App Installer is present, so resolve it explicitly
# from the WindowsApps install root.
# ------------------------------------------------------------------
function Resolve-WinGet {
    $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidate = Get-ChildItem `
        -Path "$env:ProgramFiles\WindowsApps" `
        -Filter winget.exe -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }

    return $null
}

# Wait up to ~3 min for winget to become available (App Installer may
# still be registering on a brand-new install).
function Wait-WinGet {
    for ($i = 0; $i -lt 18; $i++) {
        $wg = Resolve-WinGet
        if ($wg) { return $wg }
        Write-Step "winget not ready yet, waiting... ($i)"
        Start-Sleep -Seconds 10
    }
    return $null
}

# ------------------------------------------------------------------
# Install a single winget package id, with retries. $Override passes
# raw arguments straight to the underlying installer (used to force
# Python machine-scope + PATH).
# ------------------------------------------------------------------
function Install-WinGetId {
    param(
        [Parameter(Mandatory)] [string]$Id,
        [string]$Override = $null,
        [int]$Retries = 3
    )

    $wg = Resolve-WinGet
    if (-not $wg) { Write-Step "ERROR: winget unavailable, cannot install $Id"; return $false }

    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        Write-Step "Installing $Id (attempt $attempt/$Retries)"

        $args = @(
            'install', '--exact', '--id', $Id,
            '--accept-source-agreements',
            '--accept-package-agreements',
            '--silent',
            '--scope', 'machine',
            '--disable-interactivity'
        )
        if ($Override) { $args += @('--override', $Override) }

        & $wg @args
        $code = $LASTEXITCODE

        # 0 = ok; -1978335189 (0x8A15002B) = "no applicable upgrade /
        # already installed"; both count as success.
        if ($code -eq 0 -or $code -eq -1978335189) {
            Write-Step "OK: $Id (exit $code)"
            return $true
        }

        Write-Step "WARN: $Id failed (exit $code), retrying..."
        Start-Sleep -Seconds 15
    }

    Write-Step "ERROR: $Id did not install after $Retries attempts"
    return $false
}

# ==================================================================
#  Main
# ==================================================================
Write-Step '==== LabForge golden-image provisioning started ===='

$wg = Wait-WinGet
if (-not $wg) {
    Write-Step 'FATAL: winget never became available. Aborting automated install.'
    Write-Step 'Connect over RDP/noVNC and re-run this script once winget is ready.'
    exit 1
}
Write-Step "Using winget at: $wg"

# Pre-warm sources so the first real install doesn't pay the prompt cost.
& $wg source update --accept-source-agreements 2>$null | Out-Null

# ------------------------------------------------------------------
# Package list. Order matters only for Python (needed before pip).
# winget ids are the canonical published identifiers.
# ------------------------------------------------------------------
$results = [ordered]@{}

# Python 3.12 first - machine scope, prepend PATH, include pip.
$results['Python 3.12'] = Install-WinGetId -Id 'Python.Python.3.12' `
    -Override '/quiet InstallAllUsers=1 PrependPath=1 Include_pip=1 Include_test=0'

$results['Git (Git Bash)']   = Install-WinGetId -Id 'Git.Git'
$results['Visual Studio Code']= Install-WinGetId -Id 'Microsoft.VisualStudioCode'
$results['Postman']          = Install-WinGetId -Id 'Postman.Postman'
$results['MySQL Server 8.0']  = Install-WinGetId -Id 'Oracle.MySQL'
$results['MySQL Workbench 8.0']= Install-WinGetId -Id 'Oracle.MySQLWorkbench'
$results['MongoDB Server']   = Install-WinGetId -Id 'MongoDB.Server'
$results['MongoDB Compass']  = Install-WinGetId -Id 'MongoDB.Compass.Full'

# ------------------------------------------------------------------
# Jupyter - installed via pip on the freshly-installed Python 3.12.
# Resolve python.exe explicitly because PATH in this session predates
# the Python install.
# ------------------------------------------------------------------
Write-Step 'Installing Jupyter (notebook + jupyterlab) via pip'
$python = $null
foreach ($p in @(
    "$env:ProgramFiles\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "C:\Python312\python.exe"
)) {
    if (Test-Path $p) { $python = $p; break }
}
if (-not $python) {
    $found = Get-ChildItem "C:\" -Filter python.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'Python312' } | Select-Object -First 1
    if ($found) { $python = $found.FullName }
}

if ($python) {
    Write-Step "Using Python at: $python"
    & $python -m pip install --upgrade pip
    & $python -m pip install notebook jupyterlab
    $results['Jupyter (notebook + lab)'] = ($LASTEXITCODE -eq 0)
} else {
    Write-Step 'ERROR: Python 3.12 not found; skipping Jupyter pip install.'
    $results['Jupyter (notebook + lab)'] = $false
}

# ------------------------------------------------------------------
# Enable RDP so the linked clones are reachable through the Guacamole
# gateway (viewer = guacamole-rdp). dockur's default user is "Docker".
# ------------------------------------------------------------------
Write-Step 'Enabling Remote Desktop'
try {
    Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
        -Name 'fDenyTSConnections' -Value 0 -ErrorAction Stop
    Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue
    Write-Step 'RDP enabled.'
} catch {
    Write-Step "WARN: could not toggle RDP automatically: $($_.Exception.Message)"
}

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
Write-Step '==== Provisioning summary ===='
foreach ($k in $results.Keys) {
    $status = if ($results[$k]) { 'OK   ' } else { 'FAILED' }
    Write-Step ("  [{0}] {1}" -f $status, $k)
}

$failed = ($results.GetEnumerator() | Where-Object { -not $_.Value }).Count
if ($failed -gt 0) {
    Write-Step "==== DONE with $failed failure(s) - review C:\OEM\provision.log ===="
    exit 1
}
Write-Step '==== All packages installed successfully ===='
exit 0
