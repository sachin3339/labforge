import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

async function create(formData: FormData) {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || undefined;
  const image = String(formData.get('image') ?? '').trim();
  const runtime = String(formData.get('runtime') ?? 'code-server').trim();
  const port = Number(formData.get('port') ?? 8080);
  const cpu = Number(formData.get('cpu') ?? 1);
  const memoryMb = Number(formData.get('memoryMb') ?? 1024);
  const prewarm = Number(formData.get('prewarm') ?? 0);
  const workspaceDir = String(formData.get('workspaceDir') ?? '').trim() || undefined;
  const envRaw = String(formData.get('env') ?? '').trim();
  const graderRaw = String(formData.get('grader') ?? '').trim();
  const devicesRaw = String(formData.get('devices') ?? '').trim();
  const capAddRaw = String(formData.get('capAdd') ?? '').trim();
  const shmSizeMbRaw = String(formData.get('shmSizeMb') ?? '').trim();
  const privileged = formData.get('privileged') === 'on';
  const costPerHourRaw = String(formData.get('costPerHourUsd') ?? '').trim();
  const priceListRaw = String(formData.get('priceListUsd') ?? '').trim();
  const costPerHourUsd = costPerHourRaw ? Number(costPerHourRaw) : undefined;
  const priceListUsd = priceListRaw ? Number(priceListRaw) : undefined;

  const env: Record<string, string> = {};
  for (const line of envRaw.split(/\r?\n/)) {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) env[k.trim()] = rest.join('=').trim();
  }
  const devices = devicesRaw
    ? devicesRaw.split(/[,\s]+/).filter(Boolean)
    : [];
  const capAdd = capAddRaw
    ? capAddRaw.split(/[,\s]+/).filter(Boolean)
    : [];
  const shmSizeMb = shmSizeMbRaw ? Number(shmSizeMbRaw) : undefined;

  let grader: unknown = undefined;
  if (graderRaw) {
    try {
      grader = JSON.parse(graderRaw);
    } catch {
      redirect(`/dashboard/templates/new?error=${encodeURIComponent('invalid_grader_json')}`);
    }
  }

  const res = await apiFetch('/api/v1/templates', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      spec: {
        image,
        runtime,
        port,
        cpu,
        memoryMb,
        env,
        workspaceDir,
        prewarm,
        ...(devices.length ? { devices } : {}),
        ...(capAdd.length ? { capAdd } : {}),
        ...(shmSizeMb ? { shmSizeMb } : {}),
        ...(privileged ? { privileged: true } : {}),
        ...(costPerHourUsd !== undefined ? { costPerHourUsd } : {}),
        ...(priceListUsd !== undefined ? { priceListUsd } : {}),
        ...(grader ? { grader } : {}),
      },
    }),
  });
  if (!res.ok) {
    redirect(`/dashboard/templates/new?error=${encodeURIComponent(res.error)}`);
  }
  revalidatePath('/dashboard/templates');
  redirect('/dashboard/templates');
}

export default async function NewTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">New template</h1>
          <p className="text-sm text-ink-900/60">
            Define one kind of lab environment.
          </p>
        </div>
        <Link href="/dashboard/templates" className="btn-secondary">
          Cancel
        </Link>
      </header>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Error: {error}
        </div>
      )}

      <form action={create} className="card space-y-5">
        <Field label="Name" hint="lowercase letters, digits, hyphens">
          <input
            name="name"
            className="input font-mono"
            required
            pattern="[a-z0-9-]+"
            placeholder="vscode-python"
          />
        </Field>
        <Field label="Description">
          <input
            name="description"
            className="input"
            placeholder="Python 3 dev environment with VS Code"
          />
        </Field>
        <Field label="Container image" hint="must be pullable by the runtime">
          <input
            name="image"
            className="input font-mono"
            required
            placeholder="codercom/code-server:latest"
          />
        </Field>
        <Field label="Lab kind" hint="picks how the browser talks to the lab">
          <select name="runtime" className="input" defaultValue="code-server">
            <option value="code-server">code-server (VS Code web)</option>
            <option value="jupyter">Jupyter Lab</option>
            <option value="terminal">Terminal only (ttyd)</option>
            <option value="linux-desktop">Linux desktop (KasmVNC)</option>
            <option value="vm">VM (Windows / QEMU-in-container — needs KVM host)</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Port">
            <input name="port" type="number" className="input" defaultValue={8080} required />
          </Field>
          <Field label="vCPU">
            <input name="cpu" type="number" step="0.25" className="input" defaultValue={1} required />
          </Field>
          <Field label="Memory (MB)">
            <input name="memoryMb" type="number" className="input" defaultValue={1024} required />
          </Field>
          <Field label="Prewarm">
            <input name="prewarm" type="number" className="input" defaultValue={0} />
          </Field>
        </div>
        <Field label="Workspace dir (optional)">
          <input name="workspaceDir" className="input font-mono" placeholder="/home/coder/project" />
        </Field>
        <Field label="Env vars" hint="one KEY=VALUE per line">
          <textarea
            name="env"
            className="input h-24 font-mono"
            placeholder="PASSWORD=labforge"
          />
        </Field>

        <details className="rounded-md border border-ink-100 bg-ink-50/40 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced: devices, capabilities, shm (desktops & VMs)
          </summary>
          <div className="mt-4 space-y-4">
            <Field
              label="Host devices"
              hint="comma-separated, e.g. /dev/kvm — required for VM kind"
            >
              <input
                name="devices"
                className="input font-mono"
                placeholder="/dev/kvm"
              />
            </Field>
            <Field label="Add capabilities" hint="comma-separated, e.g. NET_ADMIN">
              <input name="capAdd" className="input font-mono" placeholder="NET_ADMIN" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Shared memory (MB)" hint="Chromium-based desktops need ≥256">
                <input
                  name="shmSizeMb"
                  type="number"
                  className="input"
                  placeholder="512"
                />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input type="checkbox" name="privileged" className="h-4 w-4" />
                <span>Run privileged (gated by host config)</span>
              </label>
            </div>
          </div>
        </details>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Cost per hour (USD)"
            hint="your infra cost; used for cost reports"
          >
            <input
              name="costPerHourUsd"
              type="number"
              step="0.001"
              min={0}
              className="input"
              placeholder="0.04"
            />
          </Field>
          <Field
            label="List price per redemption (USD)"
            hint="your revenue per student session; used for margin reports"
          >
            <input
              name="priceListUsd"
              type="number"
              step="0.01"
              min={0}
              className="input"
              placeholder="2.50"
            />
          </Field>
        </div>

        <Field
          label="Grader (JSON, optional)"
          hint='{ "passThreshold": 0.5, "checks": [{ "id":"test", "command":"npm test", "weight":1 }] }'
        >
          <textarea
            name="grader"
            className="input h-40 font-mono text-xs"
            placeholder={'{\n  "passThreshold": 0.5,\n  "checks": [\n    { "id": "node-ok", "command": "node -v", "weight": 1, "passExitCode": 0 }\n  ]\n}'}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Link href="/dashboard/templates" className="btn-secondary">
            Cancel
          </Link>
          <button className="btn-primary" type="submit">
            Create template
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-xs text-ink-900/50">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
