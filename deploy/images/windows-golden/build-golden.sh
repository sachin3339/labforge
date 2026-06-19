#!/usr/bin/env bash
# ===================================================================
# LabForge Windows-11 golden-image builder launcher.
# ===================================================================
# Boots a dockur/windows container with the LabForge OEM provisioner
# (oem/install.bat + oem/provision.ps1) mounted at /oem. dockur copies
# /oem into the guest and runs install.bat ONCE during first logon, so
# the full student toolchain (Python 3.12, Jupyter, MySQL Server +
# Workbench 8.0, Git Bash, Postman, MongoDB Server + Compass, VS Code)
# installs unattended while Windows Setup completes.
#
# Run this on a KVM-capable worker node (e.g. Node-3, root@80.243.180.81).
# When it has finished installing, follow docs/ops/windows-golden-build.md
# to snapshot the disk into the read-only golden image.
# ===================================================================
set -euo pipefail

# --- config (override via env) -------------------------------------
NAME="${NAME:-win-golden-builder}"
IMAGE="${IMAGE:-dockurr/windows:4.34}"   # keep in sync with catalog/defaults.ts
STORAGE="${STORAGE:-/labforge/win-golden-builder}"
PORT="${PORT:-8006}"
RAM="${RAM:-10G}"
CORES="${CORES:-8}"
DISK="${DISK:-64G}"

# Resolve the oem folder next to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OEM_DIR="${OEM_DIR:-$SCRIPT_DIR/oem}"

if [[ ! -f "$OEM_DIR/install.bat" ]]; then
  echo "ERROR: $OEM_DIR/install.bat not found." >&2
  exit 1
fi

mkdir -p "$STORAGE"

echo "Launching $NAME"
echo "  image   : $IMAGE"
echo "  storage : $STORAGE"
echo "  oem     : $OEM_DIR"
echo "  noVNC   : http://<node-ip>:$PORT"

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" \
  -e VERSION=11 \
  -e DISPLAY=web \
  -e RAM_SIZE="$RAM" \
  -e CPU_CORES="$CORES" \
  -e DISK_SIZE="$DISK" \
  -e KVM=Y \
  -p "$PORT:8006" \
  -v "$STORAGE:/storage" \
  -v "$OEM_DIR:/oem:ro" \
  --device /dev/kvm \
  --device /dev/net/tun \
  --cap-add NET_ADMIN \
  --privileged \
  "$IMAGE"

cat <<EOF

Builder started. Next steps:

  1. Watch progress over noVNC: http://<node-ip>:$PORT
     Windows Setup runs first (~25 min), then the OEM provisioner
     installs the toolchain. Provisioner log inside the guest:
       C:\\OEM\\provision.log

  2. When all software is present, do the final prep + shutdown and
     promote the disk to the golden image - see
     docs/ops/windows-golden-build.md (section "Capture the golden").

  3. Tail container logs meanwhile:
       docker logs -f $NAME
EOF
