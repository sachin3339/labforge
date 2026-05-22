#!/usr/bin/env bash
# Production install for LabForge on a fresh Ubuntu 24.04 box.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/labforge/main/deploy/install-prod.sh | sudo bash
#
# Or, after cloning the repo manually:
#
#   ssh ubuntu@148.113.1.66
#   git clone <repo> /opt/labforge && cd /opt/labforge
#   sudo bash deploy/install-prod.sh
#
# What it does:
#   1. apt updates + base packages
#   2. installs Docker CE
#   3. opens 22/80/443 in UFW
#   4. (if missing) copies deploy/.env.prod.example → deploy/.env.prod
#   5. generates JWT RS256 keys if not present
#   6. builds & starts the stack via docker compose
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/labforge}"
ENV_FILE="$REPO_DIR/deploy/.env.prod"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
err() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root (use sudo)."
[[ -f /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || err "Ubuntu only. Got: ${ID:-unknown}"

# ---------- 1. base packages ----------
log "Installing base packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    curl ca-certificates gnupg jq git ufw fail2ban \
    unattended-upgrades

# ---------- 2. firewall ----------
log "Configuring UFW…"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "ssh"
ufw allow 80/tcp comment "http"
ufw allow 443/tcp comment "https"
ufw --force enable

# ---------- 3. Docker ----------
if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker CE…"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release; echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
else
    log "Docker already installed — skipping."
fi
usermod -aG docker ubuntu 2>/dev/null || true

# ---------- 4. repo + env ----------
[[ -d "$REPO_DIR" ]] || err "Repo missing at $REPO_DIR. Clone it first."

if [[ ! -f "$ENV_FILE" ]]; then
    log "Creating $ENV_FILE from example — you MUST edit it before continuing."
    cp "$REPO_DIR/deploy/.env.prod.example" "$ENV_FILE"
fi

# ---------- 5. JWT keys ----------
if ! grep -q '^JWT_PRIVATE_KEY_B64=.\+' "$ENV_FILE"; then
    log "Generating RS256 keypair…"
    cd "$REPO_DIR"
    # node may not be installed; bring one in via the existing Docker image.
    docker run --rm -v "$REPO_DIR":/app -w /app node:20-slim \
        node scripts/gen-keys.mjs >> "$ENV_FILE"
fi

# ---------- 6. validation ----------
for k in CLOUDFLARE_API_TOKEN POSTGRES_PASSWORD SEED_TENANT_API_KEY JWT_PRIVATE_KEY_B64 JWT_PUBLIC_KEY_B64; do
    if ! grep -q "^${k}=.\+" "$ENV_FILE"; then
        err "Missing $k in $ENV_FILE — fill it and re-run."
    fi
done

# ---------- 7. start stack ----------
log "Building + starting the stack (first run takes 3–6 min)…"
cd "$REPO_DIR"
docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml up -d --build

# ---------- 8. summary ----------
PUB_IP=$(curl -s -4 https://ifconfig.io || hostname -I | awk '{print $1}')
log "Done."
cat <<EOF

================================================================
  ✅  LabForge production stack is up.

  Public IP:  $PUB_IP
  Endpoints (once DNS resolves + Caddy obtains certs, ~30–60s):
    Admin:  https://admin.environments.learnlytica.com
    API:    https://api.environments.learnlytica.com
    Labs:   https://<sub>.lab.environments.learnlytica.com

  First login:
    1. Open the Admin URL
    2. Paste the value of SEED_TENANT_API_KEY from $ENV_FILE
    3. Go to "Batches" → "New batch" → issue your first URLs

  Logs:
    docker compose -f deploy/docker-compose.prod.yml logs -f control-plane caddy
================================================================

EOF
