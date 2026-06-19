# Windows-11 golden image build (pre-installed student toolchain)

This runbook builds the `windows-11` template's read-only golden image
with the full LabForge student toolchain baked in, so every linked
clone boots with the software already installed.

**Toolchain installed (see [`deploy/images/windows-golden/oem/provision.ps1`](../../deploy/images/windows-golden/oem/provision.ps1)):**

| Software | Source (winget id) |
| --- | --- |
| Python 3.12 (PATH + pip) | `Python.Python.3.12` |
| Jupyter (notebook + jupyterlab) | pip on Python 3.12 |
| MySQL Server 8.0 | `Oracle.MySQL` |
| MySQL Workbench 8.0 | `Oracle.MySQLWorkbench` |
| Git (Git Bash) | `Git.Git` |
| Postman | `Postman.Postman` |
| MongoDB Server | `MongoDB.Server` |
| MongoDB Compass | `MongoDB.Compass.Full` |
| Visual Studio Code | `Microsoft.VisualStudioCode` |

Installation is automated through **dockur's `/oem` first-boot hook**:
dockur copies the mounted `oem/` folder into the guest and runs
`install.bat` once during first logon, which launches `provision.ps1`.

---

## 0. Prerequisites

- A KVM-capable worker node (e.g. Node-3, `root@80.243.180.81`).
- The `deploy/images/windows-golden/` folder available on that node
  (clone the repo or `scp` the folder over).
- Outbound internet from the guest (winget + pip downloads).

---

## 1. Launch the builder with the OEM provisioner

On the node:

```bash
cd /path/to/Labs/deploy/images/windows-golden
chmod +x build-golden.sh
./build-golden.sh
```

This boots `dockurr/windows:4.34` with `oem/` mounted at `/oem` and the
disk at `/labforge/win-golden-builder/data.img`. Override paths via env
(`STORAGE=...`, `IMAGE=...`) if your layout differs — keep `IMAGE` in
sync with the `windows-11` spec in
[`packages/control-plane/src/catalog/defaults.ts`](../../packages/control-plane/src/catalog/defaults.ts).

Watch progress:

- noVNC: `http://<node-ip>:8006`
- Container logs: `docker logs -f win-golden-builder`

Windows Setup runs first (~25 min). Then the provisioner installs the
toolchain unattended. Its log inside the guest is `C:\OEM\provision.log`.

### If the automated pass is interrupted

winget is fully reliable in an interactive admin session. Connect over
noVNC/RDP, open an **Administrator** PowerShell, and re-run:

```powershell
powershell -ExecutionPolicy Bypass -File C:\OEM\provision.ps1
```

The script is idempotent — already-installed packages are skipped.

### Verify the toolchain

In the guest, confirm everything is present before snapshotting:

```powershell
python --version          # Python 3.12.x
python -m jupyter --version
git --version
code --version
where mysql; where mongod  # or check Start menu / Programs
```

---

## 2. Capture the golden

Once the toolchain is verified, run the final prep **as Administrator**
inside the guest, then promote the disk. This is the same capture flow
as [`windows-labs-guacamole.md`](./windows-labs-guacamole.md) — see that
doc for the full detail; the short version:

```powershell
# Quiesce services so clones don't reboot / index mid-lab.
Stop-Service wuauserv; Set-Service wuauserv -StartupType Disabled
Stop-Service WSearch -ErrorAction SilentlyContinue
Set-Service  WSearch -StartupType Disabled -ErrorAction SilentlyContinue

# Clear the builder's event history.
wevtutil el | ForEach-Object { wevtutil cl "$_" }

# Clean shutdown.
shutdown /s /t 5
```

Wait for `Exited (0)`:

```bash
docker ps -a | grep win-golden-builder
```

Promote to a read-only golden:

```bash
GOLD_DIR=/opt/labforge/win-golden
sudo mkdir -p "$GOLD_DIR"
sudo mv /labforge/win-golden-builder/data.img "$GOLD_DIR/golden.img"
sudo chmod 0444 "$GOLD_DIR/golden.img"
sudo chown root:root "$GOLD_DIR/golden.img"
qemu-img info "$GOLD_DIR/golden.img"
docker rm win-golden-builder
```

Verify the overlay backing path resolves (don't skip — a wrong path
leaks the whole 64 GB into every overlay):

```bash
sudo mkdir -p /opt/labforge/instances/_smoke
sudo qemu-img create -f qcow2 -F raw \
    -b /opt/labforge/win-golden/golden.img \
    -o backing_fmt=raw \
    /opt/labforge/instances/_smoke/data.img 64G
qemu-img info /opt/labforge/instances/_smoke/data.img   # backing file must appear
sudo rm -rf /opt/labforge/instances/_smoke
```

---

## 3. Point the template at the golden

In the admin UI (**Platform → Templates → windows-11**), set on the spec:

```json
{
  "vmGoldenImage": "/opt/labforge/win-golden/golden.img",
  "vmOverlaySize": "64G",
  "vmStorageHostBase": "/opt/labforge/instances",
  "viewer": "guacamole-rdp",
  "rdpUsername": "Docker",
  "rdpPassword": "<the password set inside Windows>"
}
```

The seed runs in `create-only` mode, so these edits survive control-plane
restarts. New `windows-11` sessions now boot as ~2 GiB linked clones with
the full toolchain ready.
