/**
 * Canonical default lab catalog. Every new tenant gets these on creation,
 * and the seed re-applies them to the platform tenant on every boot so
 * spec changes ship via `git pull && docker compose restart`.
 *
 * Anything tenant-specific (pricing tiers, custom images, etc.) belongs
 * on the tenant's own template list — not here.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

export type CatalogTemplate = {
  name: string;
  description: string;
  spec: Prisma.InputJsonValue;
};

export const DEFAULT_CATALOG: CatalogTemplate[] = [
  // ----- VS Code (code-server with Node.js) -----
  {
    name: 'vscode-node',
    description: 'VS Code in browser with Node.js 20 preinstalled.',
    spec: {
      image: 'codercom/code-server:4.96.4',
      runtime: 'code-server',
      port: 8080,
      cpu: 1,
      memoryMb: 1024,
      env: {
        BIND_ADDR: '0.0.0.0:8080',
        PASSWORD: 'labforge',
        DOCKER_USER: 'coder',
      },
      workspaceDir: '/home/coder/project',
      persistPaths: ['/home/coder'],
      prewarm: 1,
      costPerHourUsd: 0.015,
      priceListUsd: 1.0,
      grader: {
        passThreshold: 0.5,
        checks: [
          {
            id: 'home-exists',
            description: 'User home directory present',
            command: 'test -d /home/coder',
            workdir: '/',
            weight: 1,
            passExitCode: 0,
            timeoutSeconds: 5,
          },
          {
            id: 'solution-file',
            description: 'Student created solution.txt containing "hello"',
            command: 'grep -q hello /home/coder/solution.txt',
            workdir: '/',
            weight: 2,
            passExitCode: 0,
            timeoutSeconds: 5,
          },
        ],
      },
    },
  },

  // ----- Ubuntu desktop (KasmVNC + Python/Jupyter/MySQL Workbench/Postman) -----
  // Image is built locally on the host from deploy/images/ubuntu-trainer/Dockerfile.
  // Sized for technical-training cohorts (validated up to 32 concurrent users
  // on a 12 vCPU / 125 GiB box).
  {
    name: 'ubuntu-desktop',
    description:
      'Ubuntu XFCE desktop with Python 3, JupyterLab, MySQL Server + Workbench, and Postman pre-installed.',
    spec: {
      image: 'labforge/ubuntu-trainer:1.1',
      runtime: 'linux-desktop',
      port: 6901,
      upstreamScheme: 'https',
      cpu: 1.5,
      memoryMb: 3584,
      env: {
        VNC_PW: 'labforge',
        KASM_SVC_PRINTER: '0',
        KASM_SVC_UPLOADS: '0',
        KASM_SVC_GAMEPAD: '0',
        KASM_SVC_AUDIO_INPUT: '0',
      },
      workspaceDir: '/home/kasm-user',
      persistPaths: ['/home/kasm-user'],
      prewarm: 0,
      shmSizeMb: 512,
      tmpfs: { '/tmp': 'size=512m' },
      // Trainees need sudo (apt-get, service control, mysql admin etc.)
      // during the session. Drops CapDrop:ALL and no-new-privileges.
      allowRoot: true,
      costPerHourUsd: 0.05,
      priceListUsd: 3.0,
    },
  },

  // ----- Kali desktop (KasmVNC) -----
  {
    name: 'kali-desktop',
    description:
      'Kali Linux desktop with the standard offensive-security toolkit.',
    spec: {
      image: 'kasmweb/kali-rolling-desktop:1.16.0',
      runtime: 'linux-desktop',
      port: 6901,
      upstreamScheme: 'https',
      cpu: 2,
      memoryMb: 3072,
      env: {
        VNC_PW: 'labforge',
        KASM_SVC_PRINTER: '0',
        KASM_SVC_UPLOADS: '0',
        KASM_SVC_GAMEPAD: '0',
        KASM_SVC_AUDIO_INPUT: '0',
      },
      workspaceDir: '/home/kasm-user',
      persistPaths: ['/home/kasm-user'],
      prewarm: 0,
      shmSizeMb: 512,
      tmpfs: { '/tmp': 'size=512m' },
      costPerHourUsd: 0.05,
      priceListUsd: 3.0,
    },
  },

  // ----- Windows 11 (QEMU-in-container via dockur/windows) -----
  //
  // Bare-metal default: no `vmGoldenImage`, no `rdpPassword`, viewer
  // defaults to noVNC :8006 — works on any KVM host out of the box but
  // every clone re-runs Windows Setup (~25 min, ~64 GiB write per
  // student). Production deployments edit this template post-seed in
  // the admin UI to:
  //
  //   - set `vmGoldenImage` to a captured raw image on the worker node
  //     (e.g. /opt/labforge/win-golden/golden.img) — flips the
  //     orchestrator into linked-clone mode (qcow2 overlay, ~2 GiB
  //     per student instead of 64 GiB)
  //   - set `viewer = 'guacamole-rdp'`, `rdpUsername = 'Docker'`, and
  //     `rdpPassword = '<the password set inside Windows>'` — flips
  //     the redeem flow into Guacamole RDP mode (clipboard, copy/paste,
  //     much smoother than noVNC at scale)
  //
  // The image tag is pinned to a known-good dockur/windows release —
  // `:latest` regressed twice during golden-image testing and lost a
  // run mid-install with no log line.
  {
    name: 'windows-11',
    description:
      'Windows 11 desktop in a browser. Needs a KVM-capable host (LAB_ALLOW_PRIVILEGED=true). Edit post-seed to enable golden-image clones and Guacamole RDP.',
    spec: {
      image: 'dockurr/windows:4.34',
      runtime: 'vm',
      port: 8006,
      // QEMU is CPU-bound for framebuffer encoding — the noVNC stream gets
      // visibly choppy on <8 vCPUs at 1080p. 8 cores + 10 GiB keeps Win11
      // responsive even with a browser + IDE open inside.
      cpu: 8,
      memoryMb: 10240,
      env: {
        VERSION: '11',
        RAM_SIZE: '10G',
        CPU_CORES: '8',
        DISK_SIZE: '64G',
        DISPLAY: 'web',
        // 1366x768 is the sweet spot: large enough to be usable, small
        // enough that QEMU + noVNC keep up at 30fps without hardware
        // acceleration. Bump up to 1600x900 only if the host has a real GPU.
        WIDTH: '1366',
        HEIGHT: '768',
        KVM: 'Y',
        // GPU passthrough requires a DRM render node on the host
        // (/dev/dri/renderD128). Bare metal hosts without an actual GPU
        // don't have one; enabling this makes QEMU crash with
        // "egl: no drm render node available". Software rendering is
        // fine for a browser-based RDP/VNC desktop.
      },
      workspaceDir: 'C:\\Users\\Docker',
      persistPaths: ['/storage'],
      prewarm: 0,
      devices: ['/dev/kvm', '/dev/net/tun'],
      capAdd: ['NET_ADMIN'],
      privileged: true,
      // The dockur container's default internal RDP port. Not the host
      // port — the host port is ephemeral, assigned by Docker on start
      // and persisted to LabInstance.rdpHostPort so Guacamole can dial it.
      rdpContainerPort: 3389,
      costPerHourUsd: 0.12,
      priceListUsd: 6.0,
    },
  },

  // ----- JupyterLab (Python data science) -----
  {
    name: 'jupyter-python',
    description:
      'JupyterLab with pandas, numpy, matplotlib, scikit-learn preinstalled.',
    spec: {
      image: 'jupyter/scipy-notebook:latest',
      runtime: 'jupyter',
      port: 8888,
      cpu: 2,
      memoryMb: 2048,
      env: {
        JUPYTER_ENABLE_LAB: 'yes',
        JUPYTER_TOKEN: '',
      },
      command: [
        'start-notebook.py',
        '--ServerApp.token=',
        '--ServerApp.password=',
        '--ServerApp.disable_check_xsrf=True',
        '--ServerApp.allow_origin=*',
        '--ServerApp.base_url=/',
      ],
      workspaceDir: '/home/jovyan/work',
      persistPaths: ['/home/jovyan'],
      prewarm: 0,
      costPerHourUsd: 0.03,
      priceListUsd: 2.0,
    },
  },

  // ----- Terminal-only Ubuntu (ttyd) -----
  {
    name: 'ubuntu-terminal',
    description:
      'Plain Ubuntu shell in the browser (ttyd). Cheapest lab, ~3s spin-up.',
    spec: {
      image: 'tsl0922/ttyd:alpine',
      runtime: 'terminal',
      port: 7681,
      cpu: 1,
      memoryMb: 512,
      env: {},
      workspaceDir: '/root',
      persistPaths: ['/root'],
      prewarm: 2,
      costPerHourUsd: 0.008,
      priceListUsd: 0.5,
    },
  },
];

/**
 * Provision the default catalog onto a tenant.
 *
 * - `mode='create-only'` (default for new tenants): only inserts templates
 *   the tenant doesn't already have. Never overwrites a tenant's edits.
 * - `mode='upsert'` (used by seed for the platform tenant): also rewrites
 *   the spec on every call so platform spec changes propagate.
 */
export async function provisionDefaultCatalog(
  prisma: PrismaClient,
  tenantId: string,
  mode: 'create-only' | 'upsert' = 'create-only',
): Promise<void> {
  for (const tpl of DEFAULT_CATALOG) {
    if (mode === 'upsert') {
      await prisma.labTemplate.upsert({
        where: { tenantId_name: { tenantId, name: tpl.name } },
        update: { description: tpl.description, spec: tpl.spec },
        create: {
          tenantId,
          name: tpl.name,
          description: tpl.description,
          spec: tpl.spec,
        },
      });
    } else {
      // create-only: don't trample a tenant's customised spec.
      const existing = await prisma.labTemplate.findUnique({
        where: { tenantId_name: { tenantId, name: tpl.name } },
        select: { id: true },
      });
      if (!existing) {
        await prisma.labTemplate.create({
          data: {
            tenantId,
            name: tpl.name,
            description: tpl.description,
            spec: tpl.spec,
          },
        });
      }
    }
  }
}
