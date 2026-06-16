#!/usr/bin/env bash
# bootstrap-node.sh
#
# One-shot setup for a fresh Ubuntu host that will run lab containers
# under the labforge control-plane. Idempotent: safe to re-run.
#
# Usage (on the NEW node, NOT the control-plane):
#     curl -fsSL https://raw.githubusercontent.com/<your-fork>/labforge/main/deploy/bootstrap-node.sh | sudo bash
# or, if the repo isn't public yet, scp this file over and run:
#     sudo bash bootstrap-node.sh
#
# Tested on Ubuntu 22.04 / 24.04. Requires root.
#
# What it does:
#   1. Installs Docker CE (official repo)
#   2. Adds ${TARGET_USER:-ubuntu} to the docker group so SSH'd-in
#      labforge daemon can talk to /var/run/docker.sock without sudo
#   3. Creates a 16 GB swapfile + sets swappiness=10 (lesson from the
#      Jun 11 OOM incident on the primary)
#   4. Bumps inotify limits — code-server / VS Code blow through the
#      Ubuntu defaults at ~6 students per host
#   5. Sets a few sysctls that matter for many small containers
#      (file descriptor cap, conntrack table)
#   6. Opens UFW for SSH from anywhere and the published container
#      port range from the control-plane primary (configurable below)
#   7. Installs qemu-utils so the orchestrator's linked-clone path
#      can run `qemu-img create` on this host for Windows VM templates
#   8. Runs a self-test and prints a summary the operator can paste
#      into the labforge "Add node" form
#
# Configurable via env vars; sensible defaults below.
#
# If the SSH login on this host is `root` (some VPS providers default to
# this), run with: `sudo TARGET_USER=root bash bootstrap-node.sh`. The
# script then skips the docker-group step (root has access by default)
# and the self-test runs without `sudo -u`.

set -euo pipefail

# ---- Tunables ---------------------------------------------------------
TARGET_USER="${TARGET_USER:-ubuntu}"
SWAP_GB="${SWAP_GB:-16}"
SWAPPINESS="${SWAPPINESS:-10}"
# Public IP of the labforge control-plane (primary). UFW will trust this
# IP to reach published container ports. Leave empty to skip the firewall
# rule — containers will still work since UFW defaults to 'allow' on a
# fresh box, but tightening later is better.
PRIMARY_IP="${PRIMARY_IP:-148.113.1.66}"
# Docker publishes lab containers on the ephemeral range. Open this on
# the firewall so the wildcard proxy on the primary can reach them.
PORT_RANGE_LOW="${PORT_RANGE_LOW:-32768}"
PORT_RANGE_HIGH="${PORT_RANGE_HIGH:-60999}"

# ---- Helpers ----------------------------------------------------------
log() { printf "\n\033[1;36m[bootstrap]\033[0m %s\n" "$*"; }
warn() { printf "\n\033[1;33m[bootstrap]\033[0m %s\n" "$*" >&2; }
die() { printf "\n\033[1;31m[bootstrap]\033[0m %s\n" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo bash $0)"
id "$TARGET_USER" >/dev/null 2>&1 || die "User '$TARGET_USER' does not exist. Set TARGET_USER=<name> if your admin user is different."

# ---- 1. Apt prerequisites + Docker ------------------------------------
log "Installing apt prerequisites…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  ufw htop iotop nload jq sysstat fail2ban \
  qemu-utils

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker CE from the official repo…"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io \
                     docker-buildx-plugin docker-compose-plugin
else
  log "Docker already installed: $(docker --version)"
fi

systemctl enable --now docker

# ---- 2. Docker group --------------------------------------------------
# root is in *every* group implicitly — no group membership change needed
# and no re-login required. Only do the usermod dance for non-root users.
if [[ "$TARGET_USER" == "root" ]]; then
  log "TARGET_USER=root — skipping docker group (root has access by default)"
elif id -nG "$TARGET_USER" | grep -qw docker; then
  log "$TARGET_USER already in docker group"
else
  log "Adding $TARGET_USER to docker group…"
  usermod -aG docker "$TARGET_USER"
  warn "User must log out and back in for docker group to take effect."
  warn "(labforge SSH connections will pick this up on the next login.)"
fi

# ---- 3. Swap ----------------------------------------------------------
if [[ "$(swapon --show=NAME --noheadings | wc -l)" -eq 0 ]]; then
  log "Creating ${SWAP_GB} GB swapfile at /swapfile…"
  fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB*1024))
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q "^/swapfile" /etc/fstab; then
    echo "/swapfile none swap sw 0 0" >> /etc/fstab
  fi
else
  log "Swap already configured: $(swapon --show)"
fi

# ---- 4. Sysctl tweaks (persist) ---------------------------------------
SYSCTL_CONF=/etc/sysctl.d/99-labforge.conf
log "Writing $SYSCTL_CONF…"
cat >"$SYSCTL_CONF" <<EOF
# labforge: prefer RAM over swap; we swap only under real pressure.
vm.swappiness=${SWAPPINESS}
# code-server / VS Code watches a LOT of files — Ubuntu's 8192 default
# is hit at ~6 students per host. 524288 is the kernel-recommended cap.
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=512
# Many containers => many file descriptors.
fs.file-max=2097152
# 36+ NAT'd containers exhaust the default conntrack table fast.
net.netfilter.nf_conntrack_max=524288
# Required by Docker bridge networking on some kernels.
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
EOF
modprobe br_netfilter 2>/dev/null || true
sysctl --system >/dev/null

# ---- 5. systemd / pam limits -----------------------------------------
LIMITS_CONF=/etc/security/limits.d/99-labforge.conf
log "Writing $LIMITS_CONF…"
cat >"$LIMITS_CONF" <<EOF
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

# ---- 6. Docker daemon defaults ----------------------------------------
DAEMON_JSON=/etc/docker/daemon.json
if [[ ! -f $DAEMON_JSON ]]; then
  log "Writing $DAEMON_JSON (log rotation, live-restore)…"
  cat >"$DAEMON_JSON" <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" },
  "live-restore": true,
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Soft": 65536, "Hard": 65536 }
  }
}
EOF
  systemctl restart docker
fi

# ---- 7. Firewall ------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  log "Configuring UFW…"
  # Allow SSH from anywhere — operator access. Tighten if you have a bastion.
  ufw allow 22/tcp comment 'ssh' >/dev/null
  if [[ -n "$PRIMARY_IP" ]]; then
    ufw allow from "$PRIMARY_IP" to any \
        port "${PORT_RANGE_LOW}:${PORT_RANGE_HIGH}" proto tcp \
        comment 'labforge primary -> ephemeral container ports' >/dev/null
  fi
  # Be safe: don't enable UFW non-interactively on a session that's
  # currently SSH'd in unless port 22 is already allowed (it is, above).
  ufw --force enable
  ufw status verbose | sed 's/^/   /'
fi

# ---- 8. Self-test -----------------------------------------------------
log "Self-test: docker hello-world…"
# Run as the target user so we exercise the same code path labforge will
# use over SSH. For root we just exec docker directly.
if [[ "$TARGET_USER" == "root" ]]; then
  test_cmd=(docker run --rm hello-world)
else
  test_cmd=(sudo -u "$TARGET_USER" docker run --rm hello-world)
fi
if "${test_cmd[@]}" >/dev/null 2>&1; then
  printf "   \033[1;32mOK\033[0m — %s can talk to docker\n" "$TARGET_USER"
else
  warn "docker hello-world as $TARGET_USER failed."
  if [[ "$TARGET_USER" != "root" ]]; then
    warn "Most common cause: $TARGET_USER hasn't re-logged in since being added to the docker group."
    warn "Fix: 'exit', SSH back in, then re-run 'docker run --rm hello-world'."
  else
    warn "Check 'systemctl status docker' and 'journalctl -u docker --no-pager | tail -50'."
  fi
fi

# ---- 9. Hint to operator ---------------------------------------------
PRIMARY_NIC=$(ip -o -4 route show to default | awk '{print $5}' | head -n1)
PUBLIC_IP=$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo "<unknown>")
PRIVATE_IP=$(ip -o -4 addr show "$PRIMARY_NIC" | awk '{print $4}' | cut -d/ -f1 | head -n1)
DOCKER_VER=$(docker --version | awk '{print $3}' | tr -d ',')

cat <<EOF

==============================================================
  Node bootstrap complete.

  Paste these into the labforge admin UI (Platform -> Nodes -> Add node):

    Connection mode :  ssh
    SSH host        :  ${PUBLIC_IP}
    SSH user        :  ${TARGET_USER}
    SSH port        :  22
    SSH password    :  <the password you set for ${TARGET_USER}>
    Proxy host      :  ${PUBLIC_IP}      (or a private/Tailscale IP if you use one)
    Bind IP         :  0.0.0.0
    Capacity hint   :  30                 (adjust based on the box's RAM/CPU)

  Quick stats:
    Docker version  :  ${DOCKER_VER}
    Public IP       :  ${PUBLIC_IP}
    Private IP      :  ${PRIVATE_IP}
    CPUs            :  $(nproc)
    Memory          :  $(free -h | awk '/^Mem:/ {print $2}')
    Swap            :  $(free -h | awk '/^Swap:/ {print $2}')

  Next steps:
    1. Click "Add node" with the values above.
    2. Click "Test connection" on the row -> expect "Ping OK".
    3. Edit the templates that should run here, check this node in
       "Allowed nodes (round-robin pool)", uncheck the others, save.
==============================================================
EOF
