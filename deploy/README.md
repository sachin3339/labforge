# LabForge — production deploy (single box)

This is the fastest path to a publicly-reachable LabForge demo.
Wraps **Caddy** (wildcard TLS via Cloudflare DNS-01) +
**Docker Compose** (postgres, redis, control-plane, admin-ui).

Tested on Ubuntu 24.04 LTS, OVH Rise-1.

## Prerequisites

1. A box reachable on TCP 80/443. (e.g. OVH 148.113.1.66)
2. A domain on Cloudflare (`learnlytica.com`).
3. **Cloudflare API token** with `Zone:DNS:Edit` on that zone:
   - Cloudflare → My Profile → API Tokens → Create Token →
     **"Edit zone DNS"** template → Zone Resources = `learnlytica.com` → Create
4. **DNS A records** (grey cloud — proxied **OFF**, since Caddy does its own TLS):

   ```
   A   admin.environments        <BOX_IP>
   A   api.environments          <BOX_IP>
   A   *.lab.environments        <BOX_IP>
   ```

## Install

```bash
# On the box
sudo mkdir -p /opt/labforge
sudo chown $USER /opt/labforge
git clone <your-repo> /opt/labforge
cd /opt/labforge

# Fill in secrets
cp deploy/.env.prod.example deploy/.env.prod
nano deploy/.env.prod        # paste CLOUDFLARE_API_TOKEN, etc.

# Run
sudo bash deploy/install-prod.sh
```

The script:
- installs Docker if missing
- opens 22/80/443 in UFW
- generates RS256 JWT keys if blank in `.env.prod`
- builds + starts the stack via `docker compose`
- prints the public URLs

First boot Caddy issues wildcard certs via DNS-01 (~30–60s).

## Day-to-day

```bash
# Tail logs
docker compose -f deploy/docker-compose.prod.yml logs -f control-plane caddy

# Restart one service
docker compose -f deploy/docker-compose.prod.yml restart control-plane

# Update after git pull
git pull && docker compose -f deploy/docker-compose.prod.yml up -d --build
```

## First admin session

1. Browse to `https://admin.environments.learnlytica.com`
2. Paste the value of `SEED_TENANT_API_KEY` from `deploy/.env.prod`
3. **Batches** → **New batch** → pick a template, set seats=50, issue → download CSV
4. Each row's `launchUrl` opens the lab in a browser, single-use, auth-gated

## Available templates (seeded)

| name | description | resources |
|---|---|---|
| `vscode-node` | VS Code (code-server) + Node.js 20 | 1 vCPU / 1 GB |
| `jupyter-python` | JupyterLab + pandas/numpy/sklearn | 2 vCPU / 2 GB |
| `ubuntu-terminal` | ttyd shell, fastest spin-up | 1 vCPU / 512 MB |
| `ubuntu-desktop` | Full XFCE via KasmVNC | 2 vCPU / 2 GB |
| `kali-desktop` | Kali offensive-security tools | 2 vCPU / 3 GB |
| `windows-11` | Windows 11 desktop *(needs KVM — disabled by default)* | 4 vCPU / 8 GB |

Add more via **Templates → New template** in the admin UI, or POST to `/api/v1/templates`.

## What's NOT in this deploy

- Real VMs (KubeVirt) — coming in the k3s upgrade path. For today,
  `windows-11` requires the host to expose `/dev/kvm` AND
  `LAB_ALLOW_PRIVILEGED=true` (off by default for safety).
- Multi-node clusters
- LTI 1.3 SSO

These are tracked separately and not needed for the container catalog.
