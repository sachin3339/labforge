import { redirect, notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

type TemplateSpec = {
  image: string;
  runtime: string;
  port: number;
  upstreamScheme?: 'http' | 'https';
  cpu: number;
  memoryMb: number;
  env?: Record<string, string>;
  workspaceDir?: string;
  prewarm?: number;
  devices?: string[];
  capAdd?: string[];
  shmSizeMb?: number;
  privileged?: boolean;
  costPerHourUsd?: number;
  priceListUsd?: number;
  grader?: unknown;
};

type Template = {
  id: string;
  name: string;
  description: string | null;
  spec: TemplateSpec;
  defaultNodeId: string | null;
};

type NodeOpt = { id: string; name: string; isDefault: boolean; enabled: boolean };

async function update(templateId: string, formData: FormData) {
  'use server';
  const description = String(formData.get('description') ?? '').trim() || null;
  const image = String(formData.get('image') ?? '').trim();
  const runtime = String(formData.get('runtime') ?? 'code-server').trim();
  const port = Number(formData.get('port') ?? 8080);
  const upstreamScheme = String(formData.get('upstreamScheme') ?? 'http') === 'https' ? 'https' : 'http';
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
  const defaultNodeRaw = String(formData.get('defaultNodeId') ?? '').trim();
  // Empty-string select option means "unpin"; we send explicit null so the
  // server-side patch handler clears the FK instead of leaving it alone.
  const defaultNodeId: string | null = defaultNodeRaw === '' ? null : defaultNodeRaw;

  const env: Record<string, string> = {};
  for (const line of envRaw.split(/\r?\n/)) {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) env[k.trim()] = rest.join('=').trim();
  }
  const devices = devicesRaw ? devicesRaw.split(/[,\s]+/).filter(Boolean) : [];
  const capAdd = capAddRaw ? capAddRaw.split(/[,\s]+/).filter(Boolean) : [];
  const shmSizeMb = shmSizeMbRaw ? Number(shmSizeMbRaw) : undefined;

  let grader: unknown = undefined;
  if (graderRaw) {
    try {
      grader = JSON.parse(graderRaw);
    } catch {
      redirect(
        `/dashboard/templates/${templateId}/edit?error=${encodeURIComponent('invalid_grader_json')}`,
      );
    }
  }

  const res = await apiFetch(`/api/v1/templates/${templateId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      description,
      defaultNodeId,
      spec: {
        image,
        runtime,
        port,
        upstreamScheme,
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
    redirect(
      `/dashboard/templates/${templateId}/edit?error=${encodeURIComponent(res.error)}`,
    );
  }
  revalidatePath('/dashboard/templates');
  redirect('/dashboard/templates');
}

export default async function EditTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const [res, nodesRes] = await Promise.all([
    apiFetch<Template>(`/api/v1/templates/${id}`),
    apiFetch<{ nodes: NodeOpt[] }>('/api/v1/platform/nodes'),
  ]);
  if (!res.ok) {
    if (res.status === 404) notFound();
    return <div className="text-red-600">Error: {res.error}</div>;
  }
  // nodesRes may 403 for non-platform tenants — fall back to empty list
  // and just hide the node picker in that case.
  const nodes: NodeOpt[] = nodesRes.ok ? nodesRes.data.nodes : [];
  const t = res.data;
  const s = t.spec;
  const envString = s.env
    ? Object.entries(s.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : '';
  const devicesString = (s.devices ?? []).join(', ');
  const capAddString = (s.capAdd ?? []).join(', ');
  const graderString = s.grader ? JSON.stringify(s.grader, null, 2) : '';

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Edit template</h1>
          <p className="text-sm text-ink-900/60">
            <span className="font-mono">{t.name}</span> — name is immutable;
            edit description and spec.
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

      <form action={update.bind(null, t.id)} className="card space-y-5">
        <Field label="Description">
          <input
            name="description"
            className="input"
            defaultValue={t.description ?? ''}
            placeholder="Python 3 dev environment with VS Code"
          />
        </Field>
        {nodes.length > 0 && (
          <Field label="Pin to node (optional)">
            <select
              name="defaultNodeId"
              className="input"
              defaultValue={t.defaultNodeId ?? ''}
            >
              <option value="">— follow tenant / default —</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id} disabled={!n.enabled}>
                  {n.name}
                  {n.isDefault ? ' (default)' : ''}
                  {!n.enabled ? ' — drained' : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-ink-900/60">
              Every lab launched from this template will run on the pinned
              node. Leave blank to use the tenant pin or the cluster default.
            </p>
          </Field>
        )}
        <Field label="Container image">
          <input
            name="image"
            className="input font-mono"
            required
            defaultValue={s.image}
          />
        </Field>
        <Field label="Lab kind">
          <select name="runtime" className="input" defaultValue={s.runtime}>
            <option value="code-server">code-server (VS Code web)</option>
            <option value="jupyter">Jupyter Lab</option>
            <option value="terminal">Terminal only (ttyd)</option>
            <option value="linux-desktop">Linux desktop (KasmVNC)</option>
            <option value="vm">VM (Windows / QEMU-in-container)</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Port">
            <input name="port" type="number" className="input" defaultValue={s.port} required />
          </Field>
          <Field label="Upstream scheme" hint="HTTPS for Kasm desktops">
            <select
              name="upstreamScheme"
              className="input"
              defaultValue={s.upstreamScheme ?? 'http'}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </Field>
          <Field label="vCPU">
            <input name="cpu" type="number" step="0.25" className="input" defaultValue={s.cpu} required />
          </Field>
          <Field label="Memory (MB)">
            <input name="memoryMb" type="number" className="input" defaultValue={s.memoryMb} required />
          </Field>
          <Field label="Prewarm">
            <input name="prewarm" type="number" className="input" defaultValue={s.prewarm ?? 0} />
          </Field>
        </div>
        <Field label="Workspace dir (optional)">
          <input
            name="workspaceDir"
            className="input font-mono"
            defaultValue={s.workspaceDir ?? ''}
          />
        </Field>
        <Field label="Env vars" hint="one KEY=VALUE per line">
          <textarea name="env" className="input h-24 font-mono" defaultValue={envString} />
        </Field>

        <details
          className="rounded-md border border-ink-100 bg-ink-50/40 px-4 py-3"
          open={Boolean(devicesString || capAddString || s.shmSizeMb || s.privileged)}
        >
          <summary className="cursor-pointer text-sm font-medium">
            Advanced: devices, capabilities, shm
          </summary>
          <div className="mt-4 space-y-4">
            <Field label="Host devices" hint="comma-separated">
              <input
                name="devices"
                className="input font-mono"
                defaultValue={devicesString}
              />
            </Field>
            <Field label="Add capabilities" hint="comma-separated">
              <input name="capAdd" className="input font-mono" defaultValue={capAddString} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Shared memory (MB)">
                <input
                  name="shmSizeMb"
                  type="number"
                  className="input"
                  defaultValue={s.shmSizeMb ?? ''}
                />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  name="privileged"
                  className="h-4 w-4"
                  defaultChecked={s.privileged === true}
                />
                <span>Run privileged</span>
              </label>
            </div>
          </div>
        </details>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Cost per hour (USD)" hint="your infra cost">
            <input
              name="costPerHourUsd"
              type="number"
              step="0.001"
              min={0}
              className="input"
              defaultValue={s.costPerHourUsd ?? ''}
            />
          </Field>
          <Field label="List price per redemption (USD)" hint="your revenue">
            <input
              name="priceListUsd"
              type="number"
              step="0.01"
              min={0}
              className="input"
              defaultValue={s.priceListUsd ?? ''}
            />
          </Field>
        </div>

        <Field label="Grader (JSON, optional)">
          <textarea
            name="grader"
            className="input h-40 font-mono text-xs"
            defaultValue={graderString}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Link href="/dashboard/templates" className="btn-secondary">
            Cancel
          </Link>
          <button className="btn-primary" type="submit">
            Save changes
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
