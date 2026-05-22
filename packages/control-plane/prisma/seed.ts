/**
 * Seed a demo tenant and the standard lab template lineup. Runs on every
 * control-plane start (idempotent upserts). Templates are kept in code so
 * spec changes ship via the normal deploy.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Upsert by (tenantId, name) and ALWAYS rewrite spec + description on every
 * boot. That's what makes `git pull && docker compose restart` enough to
 * push a template change to prod \u2014 no manual prisma steps.
 */
async function upsertTemplate(args: {
  tenantId: string;
  name: string;
  description: string;
  spec: Prisma.InputJsonValue;
}) {
  await prisma.labTemplate.upsert({
    where: { tenantId_name: { tenantId: args.tenantId, name: args.name } },
    update: { description: args.description, spec: args.spec },
    create: {
      tenantId: args.tenantId,
      name: args.name,
      description: args.description,
      spec: args.spec,
    },
  });
}

async function main() {
  const tenantName = process.env.SEED_TENANT_NAME ?? 'Demo Trainers';
  const apiKey = process.env.SEED_TENANT_API_KEY ?? 'dev-api-key-change-me';

  const tenant = await prisma.tenant.upsert({
    where: { apiKey },
    update: { name: tenantName },
    create: { name: tenantName, apiKey },
  });

  // ----- VS Code (code-server with Node.js) -----
  await upsertTemplate({
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
      // Whole home dir persists \u2014 carries dotfiles, extensions, npm cache,
      // and the project workspace itself.
      persistPaths: ['/home/coder'],
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
  });

  // ----- Ubuntu desktop (KasmVNC) -----
  await upsertTemplate({
    tenantId: tenant.id,
    name: 'ubuntu-desktop',
    description: 'Full Ubuntu XFCE desktop in the browser (KasmVNC).',
    spec: {
      image: 'kasmweb/ubuntu-jammy-desktop:1.16.0',
      runtime: 'linux-desktop',
      port: 6901,
      cpu: 2,
      memoryMb: 2048,
      env: { VNC_PW: 'labforge' },
      workspaceDir: '/home/kasm-user',
      persistPaths: ['/home/kasm-user'],
      prewarm: 0,
      shmSizeMb: 512,
      tmpfs: { '/tmp': 'size=512m' },
    },
  });

  // ----- Kali (offensive-security distro, KasmVNC) -----
  await upsertTemplate({
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
      persistPaths: ['/home/kasm-user'],
      prewarm: 0,
      shmSizeMb: 512,
      tmpfs: { '/tmp': 'size=512m' },
    },
  });

  // ----- Windows 11 (QEMU-in-container via dockur/windows) -----
  // REQUIREMENTS at the host:
  //   * /dev/kvm available and LAB_ALLOW_PRIVILEGED=true
  //   * KVM-capable CPU (vmx/svm); will NOT boot on plain WSL2.
  // The qemu disk image lives at /storage inside the container; persisting
  // that path makes Windows survive container restarts AND avoids the 8 GB
  // ISO re-download on every launch.
  await upsertTemplate({
    tenantId: tenant.id,
    name: 'windows-11',
    description:
      'Windows 11 desktop in a browser. Needs a KVM-capable host (LAB_ALLOW_PRIVILEGED=true).',
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
      // /storage holds the whole Windows qemu disk \u2014 persisting it means
      // the student keeps their installed apps, files, and OS state across
      // every reconnect.
      persistPaths: ['/storage'],
      prewarm: 0,
      devices: ['/dev/kvm', '/dev/net/tun'],
      capAdd: ['NET_ADMIN'],
      privileged: true,
    },
  });

  // ----- JupyterLab (Python data science) -----
  await upsertTemplate({
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
        JUPYTER_TOKEN: '',
        JUPYTER_ENABLE_LAB: 'yes',
      },
      workspaceDir: '/home/jovyan/work',
      persistPaths: ['/home/jovyan'],
      prewarm: 0,
    },
  });

  // ----- Terminal-only Ubuntu (ttyd) -----
  await upsertTemplate({
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
      persistPaths: ['/root'],
      prewarm: 2,
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
