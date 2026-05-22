# LabForge

On-demand, browser-based lab environments for trainers and LMS platforms.
Spin up VS Code, Jupyter, Linux containers, and (soon) full VMs from a
single signed URL — no installs, no AWS bill.

This repository contains the **v0 MVP** of the control plane and runtime.
See [plan.md](./plan.md) (session memory) for the full product plan,
architecture, cost model in INR, and GTM strategy.

## What's in v0

- **Control plane API** (Node.js + Fastify + Prisma + Postgres + Redis)
  - Tenant API-key auth
  - Lab template CRUD
  - Launch endpoint that mints short-lived signed JWT launch URLs
  - Browser-facing redeem endpoint (single-use; sets session cookie)
  - Wildcard subdomain reverse proxy (HTTP + WebSocket) to lab containers
  - Pre-warm pool reconciler
- **Docker runtime adapter** (rootless-ish, cgroup-capped, on an isolated
  `labnet`). The k8s/KubeVirt adapters drop in behind the same interface.
- **Seed data**: a `vscode-node` template using `code-server`.
- **Smoke test script** that creates a launch and prints the launch URL.

## Quick start

Prereqs: Node 20+, pnpm 9+, and **one of**:

- Docker Desktop / Docker Engine, **or**
- [Podman](https://podman.io/) 4.4+ (with `podman machine` on Windows/macOS)

### With Docker

```powershell
# 1. Install deps
pnpm install

# 2. Generate RS256 keys and copy env
Copy-Item .env.example .env
node scripts/gen-keys.mjs | Add-Content .env

# 3. Bring up the stack
pnpm stack:up

# 4. Wait ~15s for the seed to run, then smoke test:
$env:API_URL = 'http://lab.localhost:4000'
$env:API_KEY = 'dev-api-key-change-me'
node scripts/smoke.mjs
```

### With Podman (Windows / macOS / Linux)

Podman is Docker-API-compatible, so the same stack works — we just use
`podman-compose` (a thin compose-spec adapter) instead of `docker compose`.

**One-time setup**

```powershell
# Install podman-compose (Python 3.10+):
python -m pip install --user podman-compose

# Add the Python user-scripts dir to PATH if pip warned about it, e.g.:
$env:Path = "$env:LOCALAPPDATA\Packages\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\LocalCache\local-packages\Python313\Scripts;$env:Path"
# (Make it permanent in System → Environment Variables.)

# Start the Podman machine (Windows/macOS only; skip on Linux)
podman machine init   # if you haven't already
podman machine start

# Sanity check
podman ps
podman-compose --version
```

**Run the stack**

```powershell
# 1-2. Install deps and prepare env (same as Docker section above)
pnpm install
Copy-Item .env.example .env
node scripts/gen-keys.mjs | Add-Content .env

# 3. Bring up the stack via Podman
pnpm stack:up:podman

# 4. Smoke test
$env:API_URL = 'http://lab.localhost:4000'
$env:API_KEY = 'dev-api-key-change-me'
node scripts/smoke.mjs
```

**Podman socket notes**

The control-plane container needs access to the container engine socket to
spin up lab containers. Defaults work for most setups:

- **Podman on Windows/macOS (`podman machine`)** — the machine automatically
  maps `/var/run/docker.sock` inside containers to its own API socket. No
  changes needed.
- **Podman on Linux (rootless)** — set the socket path explicitly:
  ```bash
  export CONTAINER_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock
  # then: pnpm stack:up:podman
  ```
  Enable the user socket service first if it isn't running:
  ```bash
  systemctl --user enable --now podman.socket
  ```
- **Podman on Linux (rootful)** — `CONTAINER_SOCKET=/run/podman/podman.sock`.

Useful Podman commands:

```powershell
pnpm stack:logs:podman      # follow control-plane logs
pnpm stack:down:podman      # tear down (removes volumes)
podman ps                   # list running containers (control-plane + labs)
podman network ls           # confirm labforge_labnet exists
```

> Modern browsers resolve `*.localhost` to loopback automatically, so no
> hosts-file edits are needed.

## Architecture (v0)

```
  LMS / curl
     │
     │  POST /api/v1/launches  (API key auth)
     ▼
 ┌──────────────────────────────────────────────────┐
 │  Control Plane (Fastify, :4000)                  │
 │                                                   │
 │   ┌─────────────┐    ┌───────────────────────┐   │
 │   │  REST API   │    │  Wildcard Proxy       │   │
 │   │  /api/v1/*  │    │  *.lab.localhost      │   │
 │   │  /launch/*  │    │  (HTTP + WebSocket)   │   │
 │   └─────────────┘    └───────────────────────┘   │
 │          │                       │                │
 │   ┌──────▼───────────────────────▼──────┐         │
 │   │       Orchestrator                  │         │
 │   │  acquire / provision / destroy      │         │
 │   └──────────────────┬──────────────────┘         │
 │   ┌──────────────────▼──────────────────┐         │
 │   │   Runtime adapter (Docker)          │         │
 │   └──────────────────┬──────────────────┘         │
 └──────────────────────┼────────────────────────────┘
   Postgres │ Redis     │       (docker socket)
                        ▼
            ┌───────────────────────┐
            │   labnet (bridge)     │
            │                       │
            │  code-server, jupyter │
            │  ttyd, ...            │
            └───────────────────────┘
```

## API surface (v0)

| Method | Path                       | Auth         | Purpose                       |
| ------ | -------------------------- | ------------ | ----------------------------- |
| GET    | `/healthz`                 | none         | liveness                      |
| GET    | `/readyz`                  | none         | readiness (db ping)           |
| GET    | `/api/v1/templates`        | `X-Api-Key`  | list tenant templates         |
| POST   | `/api/v1/templates`        | `X-Api-Key`  | create template               |
| POST   | `/api/v1/launches`         | `X-Api-Key`  | mint launch URL               |
| GET    | `/launch/redeem?t=<JWT>`   | JWT (in URL) | redeem, set cookie, 302 to lab|
| GET    | `/internal/forward-auth`   | internal     | (for future Traefik adapter)  |

## Roadmap

The MVP covers the **80% container case** (VS Code / Jupyter / terminal).
Next milestones (see plan.md):

1. K8s/k3s runtime adapter (`packages/control-plane/src/runtime/k8s.ts`).
2. Idle detection + snapshot/resume.
3. Auto-grading framework.
4. LTI 1.3 plugin (`ltijs`).
5. Tenant admin UI (Next.js).
6. KubeVirt for Windows / network labs.
7. GPU burst adapter (RunPod / Vast.ai).
8. Cloud sandbox account vending.

## Project layout

```
.
├── docker-compose.yml         # dev stack
├── package.json               # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── scripts/
│   ├── gen-keys.mjs           # RS256 keypair generator
│   └── smoke.mjs              # end-to-end launch test
└── packages/
    ├── shared/                # zod schemas + shared TS types
    ├── control-plane/         # Fastify API + orchestrator + proxy
    │   ├── prisma/
    │   │   ├── schema.prisma
    │   │   └── seed.ts
    │   └── src/
    │       ├── auth/          # apiKey + JWT (RS256)
    │       ├── routes/        # health, templates, launches, redeem, internal
    │       ├── runtime/       # docker adapter (k8s next)
    │       ├── orchestrator.ts
    │       ├── prewarm.ts
    │       ├── wildcardProxy.ts
    │       └── server.ts
    └── gateway/               # future Traefik/Envoy configs
```
