import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { setFlash, consumeFlash } from '@/lib/flash';

type NodeRow = {
  id: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  connectionMode: 'local' | 'ssh';
  sshHost: string | null;
  sshUser: string | null;
  sshPort: number | null;
  sshKeyPath: string | null;
  proxyHost: string;
  bindIp: string;
  capacityMax: number;
  notes: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  lastError: string | null;
  dockerVersion: string | null;
  _count: { instances: number };
};

// All node mutations end with `revalidatePath` so the table reflects the
// new state on the user's very next view.
async function createNode(formData: FormData) {
  'use server';
  const body = buildNodeBody(formData);
  if (!body) return;
  const res = await apiFetch('/api/v1/platform/nodes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await setFlash({
    kind: 'nodes',
    data: res.ok
      ? { message: `Created node "${body.name}".` }
      : { error: `Create failed: ${res.error}` },
  });
  revalidatePath('/dashboard/platform/nodes');
}

async function updateNode(formData: FormData) {
  'use server';
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  const body = buildNodeBody(formData);
  if (!body) return;
  const res = await apiFetch(`/api/v1/platform/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  await setFlash({
    kind: 'nodes',
    data: res.ok
      ? { message: `Updated node "${body.name}".` }
      : { error: `Update failed: ${res.error}` },
  });
  revalidatePath('/dashboard/platform/nodes');
}

async function toggleEnabled(formData: FormData) {
  'use server';
  const id = String(formData.get('id') ?? '');
  const enabled = formData.get('enabled') === '1';
  await apiFetch(`/api/v1/platform/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  revalidatePath('/dashboard/platform/nodes');
}

async function setDefault(formData: FormData) {
  'use server';
  const id = String(formData.get('id') ?? '');
  await apiFetch(`/api/v1/platform/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isDefault: true }),
  });
  revalidatePath('/dashboard/platform/nodes');
}

async function pingNode(formData: FormData) {
  'use server';
  const id = String(formData.get('id') ?? '');
  const res = await apiFetch<{ ok: boolean; version?: string; error?: string }>(
    `/api/v1/platform/nodes/${id}/ping`,
    { method: 'POST' },
  );
  await setFlash({
    kind: 'nodes',
    data: res.ok
      ? res.data.ok
        ? { message: `Ping OK — Docker ${res.data.version}` }
        : { error: `Ping failed: ${res.data.error}` }
      : { error: `Ping request failed: ${res.error}` },
  });
  revalidatePath('/dashboard/platform/nodes');
}

async function deleteNode(formData: FormData) {
  'use server';
  const id = String(formData.get('id') ?? '');
  const res = await apiFetch(`/api/v1/platform/nodes/${id}`, { method: 'DELETE' });
  await setFlash({
    kind: 'nodes',
    data: res.ok
      ? { message: `Node deleted.` }
      : {
          error:
            res.status === 409
              ? 'Cannot delete: node still has active instances. Drain first.'
              : `Delete failed: ${res.error}`,
        },
  });
  revalidatePath('/dashboard/platform/nodes');
}

/**
 * Translate form fields into the JSON shape the control-plane expects.
 * SSH-only fields are dropped (or null'd) when the node is `local` so we
 * don't store stale credentials on a node that no longer needs them.
 */
function buildNodeBody(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return null;
  const connectionMode = (String(formData.get('connectionMode') ?? 'local') === 'ssh'
    ? 'ssh'
    : 'local') as 'local' | 'ssh';
  const isDefault = formData.get('isDefault') === '1';
  const enabled = formData.get('enabled') !== '0';
  const capacityMax = Number(formData.get('capacityMax') ?? '0') || 0;
  const proxyHost = String(formData.get('proxyHost') ?? '127.0.0.1').trim() || '127.0.0.1';
  const bindIp = String(formData.get('bindIp') ?? '127.0.0.1').trim() || '127.0.0.1';
  const notes = String(formData.get('notes') ?? '').trim() || null;

  const ssh = connectionMode === 'ssh'
    ? {
        sshHost: String(formData.get('sshHost') ?? '').trim() || null,
        sshUser: String(formData.get('sshUser') ?? 'ubuntu').trim() || 'ubuntu',
        sshPort: Number(formData.get('sshPort') ?? '22') || 22,
        sshKeyPath: String(formData.get('sshKeyPath') ?? '').trim() || null,
      }
    : { sshHost: null, sshUser: null, sshPort: null, sshKeyPath: null };

  return {
    name,
    isDefault,
    enabled,
    connectionMode,
    proxyHost,
    bindIp,
    capacityMax,
    notes,
    ...ssh,
  };
}

export default async function NodesPage() {
  const [res, flash] = await Promise.all([
    apiFetch<{ nodes: NodeRow[] }>('/api/v1/platform/nodes'),
    consumeFlash<{ message?: string; error?: string }>('nodes'),
  ]);
  if (!res.ok) {
    return (
      <div className="card text-sm text-red-600">
        Error: {res.error}
        {res.status === 403 && (
          <div className="mt-1 text-ink-900/60">
            This page is only available to platform administrators.
          </div>
        )}
      </div>
    );
  }
  const nodes = res.data.nodes;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Nodes</h1>
        <p className="text-sm text-ink-900/60">
          Physical hosts that run lab containers. New labs are scheduled to
          the node pinned on their template (or tenant), with{' '}
          <strong>default</strong> as the fallback.
        </p>
      </header>

      {flash?.message && (
        <div className="card border-emerald-300 bg-emerald-50 text-sm text-emerald-900">
          {flash.message}
        </div>
      )}
      {flash?.error && (
        <div className="card border-red-300 bg-red-50 text-sm text-red-700">
          {flash.error}
        </div>
      )}

      {/* ---- Create / connect a new node ---- */}
      <details className="card" open={nodes.length === 0}>
        <summary className="cursor-pointer text-base font-semibold">
          Add a node
        </summary>
        <p className="mt-2 text-xs text-ink-900/60">
          For a remote box: enable SSH access, drop the control-plane host's
          public key into <code>~/.ssh/authorized_keys</code> on the new node
          (user must be in the <code>docker</code> group), then fill in the
          form below. The control-plane tunnels Docker API traffic through
          SSH — no extra ports to open.
        </p>
        <NodeForm action={createNode} submitLabel="Add node" />
      </details>

      {/* ---- Existing nodes ---- */}
      {nodes.length === 0 ? (
        <div className="card text-center text-sm text-ink-900/60">
          No nodes configured yet. Add one above — the seed normally
          inserts a <code>local</code> node automatically.
        </div>
      ) : (
        <div className="space-y-4">
          {nodes.map((n) => (
            <details key={n.id} className="card">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <HealthDot node={n} />
                  <span className="font-mono text-base font-semibold">
                    {n.name}
                  </span>
                  {n.isDefault && (
                    <span className="badge bg-purple-100 text-purple-700">
                      default
                    </span>
                  )}
                  <span
                    className={`badge ${n.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-200 text-ink-700'}`}
                  >
                    {n.enabled ? 'enabled' : 'drained'}
                  </span>
                  <span className="badge bg-ink-100 text-ink-700">
                    {n.connectionMode}
                    {n.connectionMode === 'ssh' && n.sshHost
                      ? ` · ${n.sshUser ?? 'ubuntu'}@${n.sshHost}`
                      : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-ink-900/70">
                  <HealthSummary node={n} />
                  <span>
                    <strong>{n._count.instances}</strong> instances
                  </span>
                  <span>proxy → {n.proxyHost}</span>
                </div>
              </summary>

              <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
                <NodeForm action={updateNode} submitLabel="Save changes" node={n} />

                {/* Quick actions column */}
                <div className="space-y-2 text-xs">
                  <form action={pingNode}>
                    <input type="hidden" name="id" value={n.id} />
                    <button className="btn-secondary w-full" type="submit">
                      Test connection
                    </button>
                  </form>
                  {!n.isDefault && (
                    <form action={setDefault}>
                      <input type="hidden" name="id" value={n.id} />
                      <button className="btn-secondary w-full" type="submit">
                        Make default
                      </button>
                    </form>
                  )}
                  <form action={toggleEnabled}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="enabled" value={n.enabled ? '0' : '1'} />
                    <button className="btn-secondary w-full" type="submit">
                      {n.enabled ? 'Drain (disable)' : 'Re-enable'}
                    </button>
                  </form>
                  <form action={deleteNode}>
                    <input type="hidden" name="id" value={n.id} />
                    <button
                      className="w-full rounded-md border border-red-200 px-3 py-1.5 text-red-700 hover:bg-red-50"
                      type="submit"
                    >
                      Delete node
                    </button>
                  </form>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Shared create/edit form. When `node` is omitted, fields render empty for
 * the "add new" flow. The SSH block is unconditionally rendered (and its
 * relevance is controlled by `connectionMode`) — keeping it always-mounted
 * makes server-side validation idempotent on either path.
 */
function NodeForm({
  action,
  submitLabel,
  node,
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  node?: NodeRow;
}) {
  return (
    <form action={action} className="mt-3 grid gap-3 text-sm md:grid-cols-2">
      {node && <input type="hidden" name="id" value={node.id} />}

      <Field label="Name *">
        <input
          name="name"
          required
          defaultValue={node?.name ?? ''}
          placeholder="box-2"
          className="input"
        />
      </Field>

      <Field label="Connection mode">
        <select
          name="connectionMode"
          defaultValue={node?.connectionMode ?? 'ssh'}
          className="input"
        >
          <option value="local">local (control-plane host)</option>
          <option value="ssh">ssh (remote box)</option>
        </select>
      </Field>

      <Field label="Proxy host (control-plane reaches lab here)">
        <input
          name="proxyHost"
          required
          defaultValue={node?.proxyHost ?? ''}
          placeholder="10.0.0.5 or tailscale100.x.x.x"
          className="input"
        />
      </Field>

      <Field label="Bind IP (container port binds to)">
        <input
          name="bindIp"
          required
          defaultValue={node?.bindIp ?? ''}
          placeholder="10.0.0.5"
          className="input"
        />
      </Field>

      <Field label="Capacity hint (0 = unlimited)">
        <input
          name="capacityMax"
          type="number"
          min={0}
          defaultValue={node?.capacityMax ?? 0}
          className="input"
        />
      </Field>

      <Field label="">
        <div className="flex items-center gap-4 pt-2 text-xs">
          <label className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              name="isDefault"
              value="1"
              defaultChecked={node?.isDefault}
            />
            Set as default
          </label>
          <label className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              name="enabled"
              value="1"
              defaultChecked={node?.enabled ?? true}
            />
            Enabled
          </label>
        </div>
      </Field>

      <div className="md:col-span-2 mt-1 rounded-md border border-dashed border-ink-200 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-900/60">
          SSH (only used when connection mode = ssh)
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="SSH host">
            <input
              name="sshHost"
              defaultValue={node?.sshHost ?? ''}
              placeholder="148.113.1.66"
              className="input"
            />
          </Field>
          <Field label="SSH user">
            <input
              name="sshUser"
              defaultValue={node?.sshUser ?? 'ubuntu'}
              className="input"
            />
          </Field>
          <Field label="SSH port">
            <input
              name="sshPort"
              type="number"
              min={1}
              max={65535}
              defaultValue={node?.sshPort ?? 22}
              className="input"
            />
          </Field>
          <Field label="SSH private key path (on control-plane host)">
            <input
              name="sshKeyPath"
              defaultValue={node?.sshKeyPath ?? ''}
              placeholder="/etc/labforge/keys/node-2.pem"
              className="input"
            />
          </Field>
        </div>
      </div>

      <Field label="Notes">
        <textarea
          name="notes"
          rows={2}
          defaultValue={node?.notes ?? ''}
          className="input"
          placeholder="12 vCPU / 64 GiB, ovh1, etc."
        />
      </Field>

      <div className="md:col-span-2">
        <button type="submit" className="btn-primary">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <div className="mb-1 font-medium text-ink-900/70">{label || '\u00a0'}</div>
      {children}
    </label>
  );
}

/**
 * Health = green when lastSeenAt is within the staleness window (≈2 min,
 * matches NODE_HEALTH_STALE_SECONDS default on the server), red on a
 * recorded lastError, grey when never polled yet. We don't have direct
 * access to the server-side constant so we approximate at 3 minutes —
 * a poll cadence of 30s means anything older than 3 ticks is definitely
 * stale.
 */
const STALE_MS = 3 * 60_000;

function nodeHealth(n: NodeRow): 'ok' | 'down' | 'unknown' {
  if (!n.enabled) return 'unknown';
  if (n.lastSeenAt && Date.now() - new Date(n.lastSeenAt).getTime() < STALE_MS) return 'ok';
  if (n.lastError || n.lastSeenAt) return 'down';
  return 'unknown';
}

function HealthDot({ node }: { node: NodeRow }) {
  const h = nodeHealth(node);
  const tone =
    h === 'ok' ? 'bg-emerald-500' : h === 'down' ? 'bg-red-500' : 'bg-ink-300';
  const title =
    h === 'ok'
      ? `Healthy — last ping ${node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : ''}`
      : h === 'down'
        ? `Unreachable: ${node.lastError ?? 'no recent ping'}`
        : 'No health data yet (waiting for first poll)';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${tone}`} title={title} />;
}

function HealthSummary({ node }: { node: NodeRow }) {
  const h = nodeHealth(node);
  if (h === 'ok') {
    return (
      <span className="text-emerald-700">
        up · {node.dockerVersion ?? 'docker'}
      </span>
    );
  }
  if (h === 'down') {
    return (
      <span className="text-red-700" title={node.lastError ?? undefined}>
        unreachable
      </span>
    );
  }
  return <span className="text-ink-900/50">awaiting first poll</span>;
}
