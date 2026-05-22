/**
 * Seed a demo tenant and a code-server template so a smoke test can launch
 * a lab immediately after `prisma migrate dev`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenantName = process.env.SEED_TENANT_NAME ?? 'Demo Trainers';
  const apiKey = process.env.SEED_TENANT_API_KEY ?? 'dev-api-key-change-me';

  const tenant = await prisma.tenant.upsert({
    where: { apiKey },
    update: { name: tenantName },
    create: { name: tenantName, apiKey },
  });

  await prisma.labTemplate.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'vscode-node' } },
    update: {
      spec: {
        image: 'codercom/code-server:4.96.4',
        runtime: 'code-server',
        port: 8080,
        cpu: 1,
        memoryMb: 1024,
        env: {
          // code-server defaults to 127.0.0.1:8080 — force it to listen on
          // all interfaces so the port-forward / labnet DNS reaches it.
          BIND_ADDR: '0.0.0.0:8080',
          // Fixed dev password. In prod, the gateway handles auth and we
          // pass `--auth none` via DOCKER_USER + a wrapper script.
          PASSWORD: 'labforge',
          DOCKER_USER: 'coder',
        },
        workspaceDir: '/home/coder/project',
        prewarm: 1,
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
    create: {
      tenantId: tenant.id,
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
        prewarm: 1,
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
  });

  // ----- Linux desktop (Ubuntu XFCE via KasmVNC) -----
  // Single container, HTTPS on 6901, KasmVNC web client baked in.
  // Works on any docker/podman host; no /dev/kvm needed.
  await prisma.labTemplate.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'ubuntu-desktop' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'ubuntu-desktop',
      description: 'Full Ubuntu XFCE desktop in the browser (KasmVNC).',
      spec: {
        image: 'kasmweb/ubuntu-jammy-desktop:1.16.0',
        runtime: 'linux-desktop',
        port: 6901,
        cpu: 2,
        memoryMb: 2048,
        env: {
          // Default user/password for the embedded VNC. Real auth comes from
          // the gateway session cookie once that slice lands.
          VNC_PW: 'labforge',
        },
        workspaceDir: '/home/kasm-user',
        prewarm: 0,
        shmSizeMb: 512, // Chromium inside the desktop needs >=256
        tmpfs: { '/tmp': 'size=512m' },
      },
    },
  });

  // ----- Kali (offensive-security distro, KasmVNC) -----
  await prisma.labTemplate.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'kali-desktop' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'kali-desktop',
      description:
        'Kali Linux desktop with the standard offensive-security toolkit.',
      spec: {
        image: 'kasmweb/kali-rolling-desktop:1.16.0',
        runtime: 'linux-desktop',
        port: 6901,
        cpu: 2,
        memoryMb: 3072,
        env: { VNC_PW: 'labforge' },
        workspaceDir: '/home/kasm-user',
        prewarm: 0,
        shmSizeMb: 512,
        tmpfs: { '/tmp': 'size=512m' },
      },
    },
  });

  // ----- Windows 11 (QEMU-in-container via dockur/windows) -----
  // REQUIREMENTS at the host:
  //   * /dev/kvm available and the control plane has LAB_ALLOW_PRIVILEGED=true
  //   * KVM-capable CPU (vmx/svm). Will NOT boot on WSL2 without nested virt.
  // The first launch downloads the Windows ISO automatically (~5 GB) inside
  // the container's volume; subsequent launches are fast.
  await prisma.labTemplate.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'windows-11' } },
    update: {
      spec: {
        image: 'dockurr/windows:latest',
        runtime: 'vm',
        port: 8006,
        cpu: 4,
        memoryMb: 8192,
        env: {
          VERSION: '11',
          RAM_SIZE: '8G',
          CPU_CORES: '4',
          DISK_SIZE: '64G',
        },
        workspaceDir: 'C:\\Users\\Docker',
        prewarm: 0,
        devices: ['/dev/kvm', '/dev/net/tun'],
        capAdd: ['NET_ADMIN'],
        privileged: true,
      },
    },
    create: {
      tenantId: tenant.id,
      name: 'windows-11',
      description:
        'Windows 11 desktop in a browser. Needs a KVM-capable host (LAB_ALLOW_PRIVILEGED=true).',
      spec: {
        image: 'dockurr/windows:latest',
        runtime: 'vm',
        // dockur/windows exposes its noVNC web viewer on 8006.
        port: 8006,
        cpu: 4,
        memoryMb: 8192,
        env: {
          VERSION: '11',
          RAM_SIZE: '8G',
          CPU_CORES: '4',
          DISK_SIZE: '64G',
        },
        workspaceDir: 'C:\\Users\\Docker',
        prewarm: 0,
        devices: ['/dev/kvm', '/dev/net/tun'],
        capAdd: ['NET_ADMIN'],
        // dockurr/windows runs nginx + qemu internally and needs full
        // capabilities (chown, setuid in nginx) — KVM device passthrough
        // alone isn't enough.
        privileged: true,
      },
    },
  });

  // ----- JupyterLab (Python data science) -----
  await prisma.labTemplate.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'jupyter-python' } },
    update: {},
    create: {
      tenantId: tenant.id,
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
          // Disable Jupyter's own auth — gateway session cookie is the auth.
          JUPYTER_TOKEN: '',
          JUPYTER_ENABLE_LAB: 'yes',
        },
        workspaceDir: '/home/jovyan/work',
        prewarm: 0,
      },
    },
  });

  // ----- Terminal-only Ubuntu (ttyd) — cheapest, fastest spin-up -----
  await prisma.labTemplate.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: 'ubuntu-terminal' } },
    update: {},
    create: {
      tenantId: tenant.id,
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
        prewarm: 2,
      },
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded tenant "${tenant.name}" (apiKey=${apiKey})`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
