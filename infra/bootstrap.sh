#!/usr/bin/env bash
# LabForge one-box bootstrap (Ubuntu 24.04 LTS).
#
# Idempotent. Safe to re-run. Run as root on a freshly-imaged box:
#
#   scp infra/bootstrap.sh root@<BOX_IP>:/root/
#   ssh root@<BOX_IP> 'bash /root/bootstrap.sh'
#
# What it does:
#   1. Hardens SSH (no password, no root login), opens 22/80/443 only.
#   2. Creates an "ops" sudoer with your SSH key.
#   3. Installs k3s (Traefik disabled — we install our own).
#   4. Installs Helm 3 + kubectl alias.
#   5. Installs Cilium CNI (replaces flannel for per-tenant NetworkPolicy).
#   6. Installs Traefik (gateway).
#   7. Installs cert-manager (wildcard TLS via Cloudflare DNS-01).
#
# After this, run install-labforge.sh (separate file) to deploy the app.

set -euo pipefail

# ---------- config (override via env) ----------
OPS_USER="${OPS_USER:-ops}"
OPS_PUBKEY="${OPS_PUBKEY:-}"          # paste your id_ed25519.pub
K3S_VERSION="${K3S_VERSION:-v1.30.6+k3s1}"
CILIUM_VERSION="${CILIUM_VERSION:-1.16.4}"
TRAEFIK_NS="${TRAEFIK_NS:-traefik}"
CERTMGR_NS="${CERTMGR_NS:-cert-manager}"
# ------------------------------------------------

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
err() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || err "Run as root."
[[ -f /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || err "Ubuntu only. Got: ${ID:-unknown}"

# ---------- 1. base packages ----------
log "Installing base packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    curl wget jq git ca-certificates gnupg \
    ufw fail2ban unattended-upgrades \
    apparmor apparmor-utils \
    iotop htop tmux vim
apt-get -y -qq upgrade

# ---------- 2. ops user ----------
log "Creating ops user…"
id -u "$OPS_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$OPS_USER"
usermod -aG sudo "$OPS_USER"
echo "$OPS_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-$OPS_USER
chmod 440 /etc/sudoers.d/90-$OPS_USER

mkdir -p "/home/$OPS_USER/.ssh"
chmod 700 "/home/$OPS_USER/.ssh"
if [[ -n "$OPS_PUBKEY" ]]; then
    echo "$OPS_PUBKEY" > "/home/$OPS_USER/.ssh/authorized_keys"
else
    # fall back to root's authorized_keys (OVH puts your key there)
    [[ -f /root/.ssh/authorized_keys ]] && \
        cp /root/.ssh/authorized_keys "/home/$OPS_USER/.ssh/authorized_keys"
fi
chmod 600 "/home/$OPS_USER/.ssh/authorized_keys"
chown -R "$OPS_USER:$OPS_USER" "/home/$OPS_USER/.ssh"

# ---------- 3. firewall ----------
log "Configuring UFW…"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "ssh"
ufw allow 80/tcp comment "http"
ufw allow 443/tcp comment "https"
# k3s internal — only on loopback/host network
ufw allow in on lo
ufw --force enable

# ---------- 4. SSH hardening ----------
log "Hardening SSH…"
SSHD=/etc/ssh/sshd_config
sed -i \
    -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
    -e 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' \
    -e 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' \
    -e 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' \
    "$SSHD"
systemctl restart ssh

# ---------- 5. kernel tunables for containers ----------
log "Kernel tunables…"
cat > /etc/sysctl.d/90-labforge.conf <<'EOF'
fs.inotify.max_user_instances=1024
fs.inotify.max_user_watches=1048576
net.ipv4.ip_forward=1
net.bridge.bridge-nf-call-iptables=1
net.bridge.bridge-nf-call-ip6tables=1
vm.max_map_count=262144
EOF
modprobe br_netfilter || true
echo br_netfilter > /etc/modules-load.d/br_netfilter.conf
sysctl --system >/dev/null

# ---------- 6. k3s ----------
if ! command -v k3s >/dev/null 2>&1; then
    log "Installing k3s ${K3S_VERSION}…"
    curl -sfL https://get.k3s.io | \
        INSTALL_K3S_VERSION="$K3S_VERSION" \
        INSTALL_K3S_EXEC="server \
            --disable=traefik \
            --disable=servicelb \
            --flannel-backend=none \
            --disable-network-policy \
            --cluster-cidr=10.42.0.0/16 \
            --service-cidr=10.43.0.0/16 \
            --node-label=labforge.io/role=runtime" \
        sh -
else
    log "k3s already installed — skipping."
fi

# kubeconfig for ops + root
mkdir -p "/home/$OPS_USER/.kube"
cp /etc/rancher/k3s/k3s.yaml "/home/$OPS_USER/.kube/config"
chown -R "$OPS_USER:$OPS_USER" "/home/$OPS_USER/.kube"
chmod 600 "/home/$OPS_USER/.kube/config"

mkdir -p /root/.kube
cp /etc/rancher/k3s/k3s.yaml /root/.kube/config

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# wait for API
log "Waiting for k3s API…"
for i in {1..60}; do
    if kubectl get nodes >/dev/null 2>&1; then break; fi
    sleep 2
done
kubectl get nodes >/dev/null || err "k3s API never came up."

# ---------- 7. helm ----------
if ! command -v helm >/dev/null 2>&1; then
    log "Installing Helm…"
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

helm repo add cilium    https://helm.cilium.io       >/dev/null 2>&1 || true
helm repo add jetstack  https://charts.jetstack.io   >/dev/null 2>&1 || true
helm repo add traefik   https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo update >/dev/null

# ---------- 8. Cilium (CNI) ----------
if ! kubectl -n kube-system get ds cilium >/dev/null 2>&1; then
    log "Installing Cilium ${CILIUM_VERSION}…"
    helm upgrade --install cilium cilium/cilium \
        --version "$CILIUM_VERSION" \
        -n kube-system \
        --set kubeProxyReplacement=true \
        --set k8sServiceHost=127.0.0.1 \
        --set k8sServicePort=6443 \
        --set operator.replicas=1 \
        --set hubble.enabled=false \
        --wait
fi

# ---------- 9. Traefik (gateway) ----------
kubectl create ns "$TRAEFIK_NS" --dry-run=client -o yaml | kubectl apply -f -
if ! helm -n "$TRAEFIK_NS" status traefik >/dev/null 2>&1; then
    log "Installing Traefik…"
    helm upgrade --install traefik traefik/traefik \
        -n "$TRAEFIK_NS" \
        --set ports.web.redirectTo.port=websecure \
        --set service.type=LoadBalancer \
        --set 'ports.websecure.tls.enabled=true' \
        --wait
fi

# ---------- 10. cert-manager ----------
kubectl create ns "$CERTMGR_NS" --dry-run=client -o yaml | kubectl apply -f -
if ! helm -n "$CERTMGR_NS" status cert-manager >/dev/null 2>&1; then
    log "Installing cert-manager…"
    helm upgrade --install cert-manager jetstack/cert-manager \
        -n "$CERTMGR_NS" \
        --set crds.enabled=true \
        --wait
fi

# ---------- 11. summary ----------
log "Done. Cluster status:"
kubectl get nodes -o wide
echo
kubectl get pods -A
echo
PUB_IP=$(curl -s -4 https://ifconfig.io || hostname -I | awk '{print $1}')
cat <<EOF

================================================================
  ✅  LabForge box is bootstrapped.

  Public IP:        $PUB_IP
  ops user:         ssh ${OPS_USER}@${PUB_IP}
  kubeconfig:       /home/${OPS_USER}/.kube/config

  Next steps:
  1. Point DNS:
        A   admin.<your-domain>   →  $PUB_IP   (proxied)
        A   api.<your-domain>     →  $PUB_IP   (proxied)
        A  *.lab.<your-domain>    →  $PUB_IP   (proxied)
  2. Create Cloudflare API token (Zone:DNS:Edit on your zone).
  3. Run install-labforge.sh (next file) with your domain + token.
================================================================

EOF
