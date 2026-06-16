# Windows labs over Apache Guacamole — operator playbook

This doc covers everything an operator needs to do AFTER the
control-plane / admin-ui code in this branch is deployed:

1. Apply the schema migration on the primary
2. Capture the golden Windows image from the builder VM on Node-3
3. Deploy Apache Guacamole on the primary
4. Configure the singleton `GuacamoleConfig` row from the admin UI
5. Pin Win templates to Node-3 with the new spec fields

The architectural story behind these steps lives in
`docs/EXECUTION.md`; this doc is purely the runbook.

---

## 0. Prerequisites already in place (from prior session)

These were validated end-to-end and do not need to be re-done:

- Node-3 (`80.243.180.81`) joined to the control-plane via SSH, capacity
  honoured, ZFS pool `labforge` mounted at `/labforge`, WriteBack
  cache fio-validated.
- Win11 builder container running on Node-3 as `win-golden-builder`
  reachable on the existing dockur noVNC port. RDP is enabled inside
  the guest (`Docker` user / known password).
- Guacamole proves out as "as good as native RDP" for clipboard, file
  transfer, and audio.

If any of these have drifted, fix them BEFORE proceeding — the steps
below assume they hold.

### 0.1 Install qemu-utils on Node-3 (one-time)

The orchestrator's linked-clone path runs `qemu-img create` ON the
worker host. `bootstrap-node.sh` now installs `qemu-utils`, but
Node-3 was bootstrapped before that change so it likely doesn't
have `qemu-img` yet. Check and install:

```bash
ssh ubuntu@80.243.180.81 'command -v qemu-img || sudo apt-get install -y qemu-utils'
```

---

## 1. Apply the schema migration

The diff this branch introduces:

- `LabInstance.vmOverlayPath String?` — host directory of this
  instance's qcow2 overlay (cleaned on destroy).
- `LabInstance.rdpHostPort Int?` — ephemeral host port published for
  the container's RDP port (3389). Captured at provision time.
- `LabInstance.guacamoleUser String?` /
  `LabInstance.guacamolePassword String?` — per-instance Guacamole
  auto-login creds.
- New table `GuacamoleConfig` (singleton, id `'singleton'`) — gateway
  config consumed by the redeem flow.

On the primary (where the control-plane runs):

```bash
cd /srv/labforge   # or wherever the deploy lives
git pull
pnpm install
pnpm --filter @labforge/control-plane prisma:migrate -- \
    --name add_guacamole_and_linked_clone
# Restart the control-plane process / container so the new prisma
# client is loaded.
sudo systemctl restart labforge-control-plane
# OR: docker compose restart control-plane
```

**Verify**:

```bash
psql "$DATABASE_URL" -c "\d \"LabInstance\"" | \
  grep -E "vmOverlayPath|rdpHostPort|guacamoleUser"
psql "$DATABASE_URL" -c "\d \"GuacamoleConfig\""
```

You should see the four new columns on `LabInstance` and the new
`GuacamoleConfig` table.

---

## 2. Capture the Windows golden image

The Win11 builder is currently running with its qcow2/raw disk at
`/labforge/win-golden-builder/data.img` (or wherever the dockur
container's `/storage` was bind-mounted to on Node-3 — adjust paths
to match your actual layout).

### 2.1 Final prep inside the guest (over Guacamole RDP)

Connect to the builder over the existing noVNC URL or via a
temporary direct RDP session and run, **as Administrator**:

```powershell
# Stop and disable Windows Update so freshly cloned labs don't
# unexpectedly reboot during a session. (Re-enable if you want
# automatic patching of the golden later.)
Stop-Service wuauserv
Set-Service  wuauserv -StartupType Disabled

# Disable the search indexer — it's expensive on small VMs and
# the students don't need it in a 30-min lab.
Stop-Service WSearch -ErrorAction SilentlyContinue
Set-Service  WSearch -StartupType Disabled -ErrorAction SilentlyContinue

# Clear the Windows event log so every clone doesn't carry the
# builder's history.
wevtutil el | ForEach-Object { wevtutil cl "$_" }

# OPTIONAL: run sysprep generalize for SID-uniqueness across clones.
# Skip if your labs are short-lived and SID collisions don't matter
# (Guacamole sessions don't talk to each other).
#   C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown

# If you skipped sysprep, do a clean shutdown:
shutdown /s /t 5
```

Wait until the dockur container reports `Exited (0)` (`docker ps -a`
on Node-3, look for `win-golden-builder`).

### 2.2 Promote the disk to a read-only golden

On Node-3:

```bash
# Path layout this branch defaults to:
GOLD_DIR=/opt/labforge/win-golden
mkdir -p "$GOLD_DIR"

# Move the builder's disk into the golden location and lock it down.
# (Adjust the source path to match your builder bind-mount.)
sudo mv /labforge/win-golden-builder/data.img "$GOLD_DIR/golden.img"
sudo chmod 0444 "$GOLD_DIR/golden.img"
sudo chown root:root "$GOLD_DIR/golden.img"

# Verify it's a raw image of the size you expect.
qemu-img info "$GOLD_DIR/golden.img"

# Tear down the builder container so nothing accidentally writes
# to the golden again.
docker rm win-golden-builder
```

The orchestrator's linked-clone path expects the golden at
`<spec.vmGoldenImage>` exactly as shown above (template spec field).

### 2.3 Verify the overlay path works

Quick sanity check — DON'T skip this, a wrong backing-file path
leaks the entire 64 GB raw image into every overlay:

```bash
sudo mkdir -p /opt/labforge/instances/_smoke
sudo qemu-img create -f qcow2 \
    -F raw \
    -b /opt/labforge/win-golden/golden.img \
    -o backing_fmt=raw \
    /opt/labforge/instances/_smoke/data.img 64G
qemu-img info /opt/labforge/instances/_smoke/data.img
# 'backing file: /opt/labforge/win-golden/golden.img' must appear.
sudo rm -rf /opt/labforge/instances/_smoke
```

NOTE: the orchestrator stores the **absolute** golden path inside
each overlay's qcow2 header. At container start time qemu (running
inside the dockur container) resolves that absolute path **inside
the container's filesystem**, so the orchestrator bind-mounts the
golden read-only at the same path automatically. Don't move the
golden after the first lab launches against a template — every
in-flight overlay is referencing it by absolute path.

---

## 3. Deploy Apache Guacamole on the primary

We run Guacamole in two containers on the primary host
(`148.113.1.66`), behind whatever TLS terminator you already use for
`api.<root>` / the admin UI. The control-plane writes
`user-mapping.xml` directly to a bind-mounted path; Guacamole
re-reads it on every login, so no service restart is needed when a
lab comes or goes.

`/srv/guacamole/docker-compose.yml`:

```yaml
services:
  guacd:
    image: guacamole/guacd:1.5.5
    restart: unless-stopped
    # guacd is the protocol bridge. It does NOT need to be
    # internet-exposed; only the guacamole web UI talks to it.
    networks: [internal]

  guacamole:
    image: guacamole/guacamole:1.5.5
    restart: unless-stopped
    depends_on: [guacd]
    environment:
      GUACD_HOSTNAME: guacd
      GUACD_PORT: '4822'
      # File-based auth — the only auth source we mount.
      GUACAMOLE_HOME: /etc/guacamole
    volumes:
      - ./guacamole-home:/etc/guacamole:ro
    ports:
      # Bind to localhost; your TLS terminator (Caddy/Traefik/nginx)
      # will reverse-proxy https://rdp.<root> -> 127.0.0.1:8080.
      - '127.0.0.1:8080:8080'
    networks: [internal]

networks:
  internal: {}
```

`/srv/guacamole/guacamole-home/guacamole.properties`:

```
# Tell Guacamole to use the file-based auth provider only.
auth-provider: net.sourceforge.guacamole.net.auth.file.FileAuthenticationProvider
basic-user-mapping: /etc/guacamole/user-mapping.xml
# Reread the file on every login. (This is the default but we set
# it explicitly so it's clear in code review why we don't reload
# the service.)
```

Seed the `user-mapping.xml` with an empty body (the control-plane
will overwrite it on first regenerate):

```bash
sudo mkdir -p /srv/guacamole/guacamole-home
sudo tee /srv/guacamole/guacamole-home/user-mapping.xml > /dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<user-mapping>
</user-mapping>
EOF
sudo chmod 0640 /srv/guacamole/guacamole-home/user-mapping.xml
```

Bring it up:

```bash
cd /srv/guacamole
docker compose up -d
docker compose logs --tail=50 guacamole
# Look for "Guacamole 1.5.5 started" with no auth-provider errors.
```

Reverse-proxy `https://rdp.<root>` to `http://127.0.0.1:8080` in
your existing TLS terminator. The guacamole client lives at the
`/guacamole/` path — be sure to forward that prefix unchanged.

Smoke test from a browser:

```
https://rdp.<root>/guacamole/
```

You should see the login screen. Don't log in yet; the user-mapping
is empty.

---

## 4. Configure the `GuacamoleConfig` singleton

This is the row the redeem flow reads to decide where to redirect
students whose template uses `viewer: 'guacamole-rdp'`.

In the admin UI (as a platform-role tenant):

1. Navigate to **Platform → Guacamole** in the sidebar.
2. Fill in:
   - **Public URL**: `https://rdp.<root>` (no trailing slash, no
     `/guacamole`).
   - **user-mapping.xml path**:
     `/srv/guacamole/guacamole-home/user-mapping.xml`.
   - **Default RDP host (fallback)**: `80.243.180.81` — Node-3's
     public IP. Used only when a node has no `proxyHost`.
   - **Gateway enabled**: ✅
3. **Remote-write (SSH)** section:
   - If the control-plane is on the SAME host as Guacamole, leave
     "Write user-mapping.xml over SSH" unchecked. The file is
     written directly via `mkdir/rename`.
   - If the control-plane is on a DIFFERENT host, check the box and
     fill in SSH host / user / port / key path for an account that
     can write to the user-mapping path on the Guacamole host.
4. Click **Save configuration**.
5. Click **Resync now**. With no live `guacamole-rdp` instances the
   rendered count should be `0` and the file becomes a stub
   `<user-mapping></user-mapping>`. That confirms write permissions.

---

## 5. Pin Win templates to Node-3 and turn on linked-clone

For each Windows template (e.g. the seeded `windows-11`):

1. **Templates → edit the template**.
2. Open **Advanced placement** (or whatever the panel is called in
   your build) and add Node-3 to `allowedNodeIds`. Remove any other
   nodes — the golden only exists on Node-3.
3. Open **VM & RDP gateway (Windows / KVM only)**:
   - **VM golden image**: `/opt/labforge/win-golden/golden.img`
   - **VM overlay size**: `64G` (or whatever you sized the golden
     for)
   - **Storage host base**: leave default
     `/opt/labforge/instances` unless you want overlays on a
     different mount.
   - **Viewer**: `guacamole-rdp`
   - **RDP username**: `Docker` (the dockur default — change if you
     hardened it)
   - **RDP password**: the Windows password baked into the golden.
     Stored encrypted-at-rest; the form shows `***` on read and
     leaves it untouched if you don't retype it.
   - **RDP container port**: `3389` (default — leave unless you
     remapped it inside the guest).
4. Save.

Do a launch test:

1. Create a one-shot launch URL for this template against your own
   `userIdHash`.
2. Click it. The redeem flow should:
   - Detect `viewer: 'guacamole-rdp'`.
   - Mint a per-instance lab user / password.
   - Re-render `user-mapping.xml` and ship it to the file path.
   - Redirect you to
     `https://rdp.<root>/guacamole/?username=lab-…&password=…`.
3. You should land directly on the Windows desktop — no Guacamole
   login screen, no connection picker.
4. After you finish, terminate the lab. The orchestrator clears the
   creds and re-renders the file; the URL stops working.

---

## 6. Day-2 ops cheat sheet

| Symptom                                                  | First thing to check                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Student gets Guacamole login screen instead of desktop   | The XML file wasn't written — check `regenerateUserMapping` log warnings on the control-plane.                 |
| "Connection refused" inside Guacamole                    | RDP host port drifted across resume — call `/api/v1/platform/guacamole/resync` or click Resync in the UI.      |
| Every clone shows the builder's hostname / SID           | You skipped sysprep in step 2.1. Decide if it matters; rebuild golden if it does.                              |
| Overlay creation fails with `Could not open backing file` | `/opt/labforge/win-golden/golden.img` mode/owner is wrong on Node-3. `chmod 0444` and re-test.                 |
| Disk fills up on Node-3 over time                        | `du -sh /opt/labforge/instances/*` — orphaned overlays. Cross-check with `LabInstance` rows where `status='terminated'` and `vmOverlayPath` non-null; manual cleanup if so. |

---

## 7. Carry-over from prior session

These are unrelated to this branch but were noted as still-open
operator actions:

- Add a permanent swapfile entry to `/etc/fstab` on Node-3 so the
  swap survives reboots (currently runtime-only).
