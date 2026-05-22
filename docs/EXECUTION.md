# LabForge Execution Plan

> **Mission**: cheap (₹12–149/pax/day Standard tier) + high-performance
> (p95 keystroke < 80 ms, p95 warm launch < 5 s) browser labs that
> undercut Instruqt/Skillable/Strigo by 15–30× on Indian/APAC GTM.

The strategy lives in `/memories/session/plan.md` (cost model, INR pricing,
GTM, full architecture). This file is the **engineering backlog** that turns
that plan into a shippable v1.

---

## 1. v1 cut-line (locked)

**Ships in v1** — everything needed to close the first paid pilot
(30-seat DevOps bootcamp, Pro tier @ ₹299/pax/day):

| Capability | Status |
|---|---|
| Standard-tier labs (code-server, Jupyter, ttyd) | ✅ template + runtime done |
| Pro-tier Linux desktop labs (KasmVNC: Ubuntu, Kali, Fedora) | ✅ templates seeded |
| LMS-friendly **launch URL** API (signed JWT, 60 s, single-use) | ✅ done |
| Wildcard subdomain gateway with WS upgrade | ✅ done |
| Prewarm pool per template | ✅ done |
| Auto-grader (exec + weighted checks + HMAC webhook) | ✅ done |
| Tenant admin UI (templates, instances, key rotation, launch test, grade) | ✅ done |
| **Idle detect → snapshot → suspend → resume** (the cost lever) | ❌ **next slice** |
| Metering events (per-launch usage rows for invoicing) | ❌ |
| Gateway lab-session cookie (kill shared VNC password) | ❌ |
| One-region k3s + Helm deploy on Hetzner AX102 | ❌ |
| Cloudflare in front (TLS termination + WS proxy) | ❌ |
| Per-tenant network isolation (Cilium NetworkPolicy) | ❌ |
| Tenant cost dashboard (pax-days consumed this month) | ❌ |

**Deferred to v1.5** (after pilot revenue):

- **LTI 1.3** (`ltijs`) — launch URL works for v1 pilots; LTI needed
  only when we sell into Moodle/Canvas-bound buyers.
- **Windows VMs** (KubeVirt or dedicated EC2/Hetzner with KVM) — biggest
  margin floor; high lift; only 1 Windows tier is unlocked.
- **Sysbox / Kata** for K8s-in-the-lab — needed for K8s certification tier.
- **Instructor shadow** (read-only WS mirror with takeover).
- **Multi-region** (SIN, FRA, USE) — single BLR cluster is enough for the
  first 1 000 pax-days.

**Explicitly out of scope until v2**:

- GPU labs (RunPod/Vast adapter).
- Cloud-sandbox accounts (AWS Org / Azure Sub vending).
- Network-topology labs (Containerlab).
- Marketplace, session recording, collaborative editing.

---

## 2. What's already built

Mapped to the plan's reference architecture:

```
LMS → [Cloudflare] → Control plane (Fastify) ─┬─ /api/v1/launches      ✅
                                              ├─ /api/v1/templates     ✅
                                              ├─ /api/v1/admin/*       ✅
                                              ├─ /api/v1/grading/*     ✅
                                              └─ wildcardProxy WS/HTTP ✅

   Prewarm loop (15 s)                                                  ✅
   Postgres + Prisma (Tenant, LabTemplate, Launch,
                       LabInstance, GradingResult)                      ✅
   Docker/Podman runtime adapter                                        ✅
     - bin-packs containers
     - devices / capAdd / sysctls / tmpfs / shm / privileged knobs
     - LAB_ALLOW_PRIVILEGED gate for VM-kind templates
   Admin UI (Next.js 15) — login, templates CRUD, instances, settings   ✅
   Auto-grader — runtime.exec, weighted checks, webhook                 ✅
```

Lab kinds wired end-to-end today:

- `code-server` (vscode-node) — verified runs in browser
- `linux-desktop` (ubuntu-desktop, kali-desktop) — seeded, KasmVNC 6901
- `vm` (windows-11, dockur/windows) — template only, needs KVM host
- `jupyter`, `terminal` — schema accepts them, no seeded template yet

---

## 3. The next 6 slices (priority order)

Each slice is sized to ship in 1–3 days. Each has a **Definition of Done**
and a **smoke test** that proves it.

### Slice A — Idle detect + snapshot + resume *(unblocks the ₹12 number)*

The biggest single lever in the cost model. Without it, a Pro-tier lab
that costs ₹40/pax-day really costs ₹70–90 (student leaves browser open
during lunch).

**Build**

1. Lab heartbeat: gateway records `lastSeenAt` on every WS frame /
   HTTP hit for that subdomain. Already have `LabInstance.lastSeenAt`
   column — wire the wildcardProxy to update it (debounced 5 s).
2. Idle worker: every minute, scan `LabInstance.status='ready'` rows
   where `now() - lastSeenAt > LAB_IDLE_TIMEOUT_MINUTES`. Transition to
   `idle`. After a further `LAB_PAUSE_AFTER_IDLE_MINUTES` (default 5),
   transition to `paused`.
3. Snapshot: on `paused`, call `runtime.suspend(instanceId)`:
   - Docker adapter v1 = `docker commit` the FS to a per-instance image
     ref, then `docker stop`. Image stays on local node disk
     (~MB-scale for code-server deltas).
   - Persist `LabInstance.snapshotRef = <imageId>`.
4. Resume: on next request to the subdomain, gateway checks status.
   If `paused`, calls `runtime.resume(instanceId)`:
   - `docker run` from `snapshotRef` on the same network alias.
   - Status → `provisioning` → `ready` after `isReady` flips.
   - Browser sees a small "Reconnecting…" page (HTML served by the
     gateway) until ready, then 302s to the lab.
5. Schema additions: `LabInstance.snapshotRef String?`,
   `LabInstance.pausedAt DateTime?`.
6. Config: `LAB_IDLE_TIMEOUT_MINUTES` (already exists, default 10),
   `LAB_PAUSE_AFTER_IDLE_MINUTES=5`, `LAB_RESUME_TIMEOUT_SECONDS=30`.

**Definition of Done**

- Idle code-server pauses within 15 min of last keystroke.
- Reopening the launch URL within session TTL resumes from snapshot in
  < 10 s and the editor's open files are preserved.
- `docker stats` shows no CPU / RAM consumed during the paused window.

**Smoke test**

`scripts/idle-pause.spec.ps1`: launch → write file → wait 16 min →
reopen subdomain → expect HTTP 200 + the file present.

> v1.5: replace `docker commit + restart` with CRIU checkpoint (faster
> resume, preserves running process state). For now `commit + restart`
> is good enough — code-server reattaches to the editor session on
> reload because its state lives on disk.

---

### Slice B — Metering & per-tenant usage API

We can't invoice without numbers.

**Build**

1. New table `UsageEvent { id, tenantId, launchId, instanceId, kind, payload, occurredAt }`. Kinds: `launch.created`, `instance.ready`, `instance.idle`, `instance.paused`, `instance.resumed`, `instance.terminated`.
2. Emit events from the orchestrator / idle worker / destroy paths.
3. Derived view: `pax-days = COUNT(DISTINCT (tenantId, userIdHash, date)) ` over a window. SQL view + an admin endpoint `GET /api/v1/admin/usage?from&to&groupBy=template`.
4. Admin UI: new **Usage** tab with month-to-date pax-days per template + a CSV export.

**DoD**

- 30 launches across 3 templates ⇒ `pax-days` shows the right per-template breakdown.
- CSV export opens cleanly in Excel.

**Smoke test**

`scripts/usage-replay.spec.ps1`: synth 30 launches, hit `/usage`, assert totals.

---

### Slice C — Gateway lab-session cookie

Kills the `VNC_PW=labforge` shared-secret smell on desktop / VM kinds, and
prepares for LTI's grade-passback flow.

**Build**

1. After `/launch/redeem`, gateway already 302s to `{sub}.lab.host`.
   Before the 302, set an httpOnly cookie `lf_lab_<instanceId>=<sessionJwt>`
   scoped to `.lab.host`. Session JWT (RS256, exp = `LAB_MAX_DURATION`)
   carries `instanceId`, `userIdHash`, `tenantId`.
2. wildcardProxy `onRequest` hook: verify the cookie matches the
   subdomain; reject otherwise with 401 + a tiny "session expired" page.
3. For desktops, drop the public `VNC_PW` from the spec and pass it
   through `runtime.exec` at provision time as a per-instance ephemeral
   secret (or keep `VNC_PW` random per instance — orchestrator generates
   on provision, stores hashed).

**DoD**

- Pasting a lab subdomain URL into an unrelated browser returns 401.
- The legitimate flow (LMS → launch URL → redeem → lab) still works.

**Smoke test**

`scripts/session-cookie.spec.ps1`.

---

### Slice D — k3s + Helm deploy + Cloudflare in front

Move from `pnpm dev` on Windows to the production substrate.

**Build**

1. Helm chart in `deploy/helm/labforge` with:
   - `control-plane` deployment (3 replicas, HPA).
   - `admin-ui` deployment (2 replicas).
   - Postgres via `bitnami/postgresql` (or use Patroni later).
   - Redis via `bitnami/redis`.
   - `wildcard-cert` cert-manager `Certificate` (Cloudflare DNS-01).
   - `IngressRoute` for the API + admin-ui + `*.lab.<domain>`.
   - `NetworkPolicy` namespace-scoped per-tenant (label `labforge.io/tenant=<id>`).
2. Container images: Dockerfiles for control-plane + admin-ui;
   `pnpm deploy` for slim runtimes; GHCR push from GitHub Actions.
3. K3s install script in `deploy/hetzner/install.sh` (single-node first,
   3-node HA next).
4. Cloudflare: zone, Origin CA cert, WAF rules, Page Rules to bypass
   cache on `*.lab.<domain>`. Document in `deploy/cloudflare/README.md`.

**DoD**

- `helm install labforge ./deploy/helm/labforge` on a fresh k3s gives a
  working admin UI at `https://admin.lab.example.com` and a launch URL
  flow that opens a vscode-node lab.

**Smoke test**

`scripts/deploy-smoke.sh` runs end-to-end against the public URL.

---

### Slice E — Per-tenant network isolation (Cilium NetworkPolicy)

Required before we onboard a second paying tenant.

**Build**

1. Cilium CNI on the k3s cluster.
2. Default-deny `NetworkPolicy` for namespace `labforge-labs`.
3. Orchestrator labels each lab pod `labforge.io/tenant=<id>` +
   `labforge.io/instance=<id>`.
4. Generated `CiliumNetworkPolicy`: lab → control-plane (only the
   metering endpoint), lab → DNS, lab → internet (egress only,
   block RFC-1918 except the explicit egress proxy). Block lab → lab.

**DoD**

- Pen-test script (`scripts/tenant-isolation.spec.ps1`) launches one
  lab as Tenant A and one as Tenant B; A cannot reach B's pod IP.

---

### Slice F — Tenant cost dashboard

The thing pilot customers actually want to see.

**Build**

1. Tile per template: pax-days MTD, % of plan consumed.
2. Bar chart: pax-days per day for last 30 days.
3. Cost-to-tenant: `pax-days × <list price per tier>` (config table).
4. Cost-to-us (internal): join with node-runtime metrics from Prometheus
   (deferred until D ships).

---

## 4. Path to first paid pilot

```
Slice A (idle)  ──┐
Slice B (meter) ──┼──► Cloudflare + k3s on one Hetzner AX102  ──► pilot
Slice C (cookie)──┘                (Slice D)
```

Slice E and F can land in parallel with the pilot.

**Pilot definition**

- 1 lighthouse training-co (Edureka/KnowledgeHut/KodeKloud-style).
- 30 seats × 5 days DevOps bootcamp.
- Pro tier (KasmVNC Ubuntu + grader for `kubectl`/`docker` checks).
- ₹299/seat/day @ 50% lighthouse discount = ₹149.50/seat/day.
- Revenue ₹22,425 · Direct infra cost ₹6,000 · Net ≈ ₹12 k.
- Written case study + public logo as compensation for the discount.

**Pilot smoke test before sales hand-off**

`scripts/pilot-readiness.ps1` runs:

1. 30 parallel launches against `ubuntu-desktop` from a test tenant.
2. Asserts p95 launch < 5 s, all reach `ready`.
3. Sends 30 heartbeats, waits 16 min, expects 30 → `paused` and
   `docker stats` shows zero CPU.
4. Resumes 30, expects p95 resume < 10 s.
5. Runs grader against 5, expects 5 distinct `GradingResult` rows.

---

## 5. Non-goals for this engineering plan

- **Sales collateral** (one-pager PDF, demo Loom). Out of repo.
- **Procurement** (Hetzner contract, INR billing, GST registration). Out
  of repo — handled commercially.
- **Content** (lab curricula, instructor scripts). Trainers' job; we ship
  the platform, they ship the courseware.

---

_Last updated: 2026-05-21. Status of slices is tracked via the agent's
todo list during each session; see `/memories/repo/` for the current
focus._
