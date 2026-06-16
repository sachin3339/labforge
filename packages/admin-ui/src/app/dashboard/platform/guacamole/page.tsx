import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { setFlash, consumeFlash } from '@/lib/flash';

/**
 * Singleton config row for the Guacamole gateway. The control-plane
 * holds exactly one of these (id='singleton'); the redeem flow reads it
 * to decide whether to redirect a `guacamole-rdp` template through the
 * gateway or fall back to the legacy in-container noVNC URL.
 *
 * `sshPassword` is intentionally redacted on the server before reaching
 * this page — the form treats an empty input as "leave unchanged" and
 * exposes a Clear button for the explicit-null path. Same semantics as
 * the Nodes page.
 */
type GuacamoleConfigRow = {
  id: string;
  publicUrl: string;
  userMappingPath: string;
  sshHost: string | null;
  sshUser: string | null;
  sshPort: number | null;
  sshKeyPath: string | null;
  defaultRdpHost: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

async function saveConfig(formData: FormData) {
  'use server';
  const body = buildBody(formData);
  if (!body) return;
  const res = await apiFetch('/api/v1/platform/guacamole', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  await setFlash({
    kind: 'guacamole',
    data: res.ok
      ? { message: 'Guacamole configuration saved.' }
      : { error: `Save failed: ${res.error}` },
  });
  revalidatePath('/dashboard/platform/guacamole');
}

async function resyncMapping() {
  'use server';
  const res = await apiFetch<{ ok: boolean; rendered?: number; written?: boolean; error?: string }>(
    '/api/v1/platform/guacamole/resync',
    { method: 'POST' },
  );
  await setFlash({
    kind: 'guacamole',
    data: res.ok
      ? res.data.ok
        ? {
            message: `Resynced. Rendered ${res.data.rendered ?? 0} entries${
              res.data.written ? '' : ' (gateway disabled — file not written)'
            }.`,
          }
        : { error: `Resync failed: ${res.data.error}` }
      : { error: `Resync request failed: ${res.error}` },
  });
  revalidatePath('/dashboard/platform/guacamole');
}

function buildBody(formData: FormData) {
  const publicUrl = String(formData.get('publicUrl') ?? '').trim();
  const userMappingPath = String(formData.get('userMappingPath') ?? '').trim();
  if (!publicUrl || !userMappingPath) return null;
  const enabled = formData.get('enabled') === '1';
  const remote = formData.get('remoteWrite') === '1';
  const sshFields = remote
    ? {
        sshHost: String(formData.get('sshHost') ?? '').trim() || null,
        sshUser: String(formData.get('sshUser') ?? '').trim() || null,
        sshPort: Number(formData.get('sshPort') ?? '22') || 22,
        sshKeyPath: String(formData.get('sshKeyPath') ?? '').trim() || null,
        // Same edit semantics as nodes: empty = keep, "clear" button =
        // explicit null, anything else = overwrite.
        ...(() => {
          if (formData.get('sshPasswordClear') === '1') return { sshPassword: null };
          const raw = String(formData.get('sshPassword') ?? '');
          if (raw === '') return {};
          return { sshPassword: raw };
        })(),
      }
    : {
        sshHost: null,
        sshUser: null,
        sshPort: null,
        sshKeyPath: null,
        sshPassword: null,
      };
  const defaultRdpHost = String(formData.get('defaultRdpHost') ?? '').trim() || null;
  return { publicUrl, userMappingPath, enabled, defaultRdpHost, ...sshFields };
}

export default async function GuacamolePage() {
  const [res, flash] = await Promise.all([
    apiFetch<{ config: GuacamoleConfigRow | null }>('/api/v1/platform/guacamole'),
    consumeFlash<{ message?: string; error?: string }>('guacamole'),
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
  const cfg = res.data.config;
  const remote = !!cfg?.sshHost;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Guacamole gateway</h1>
        <p className="mt-1 text-sm text-ink-700">
          Apache Guacamole hosts the HTML5 RDP viewer for Windows / VM
          templates. The control-plane is the sole writer of{' '}
          <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">user-mapping.xml</code>
          ; Guacamole re-reads it on every login, so adding or removing
          a lab does not require a service restart.
        </p>
      </div>

      {flash?.message && (
        <div className="card border-green-200 bg-green-50 text-sm text-green-800">
          {flash.message}
        </div>
      )}
      {flash?.error && (
        <div className="card border-red-200 bg-red-50 text-sm text-red-800">{flash.error}</div>
      )}

      <form action={saveConfig} className="card space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Public URL"
            name="publicUrl"
            defaultValue={cfg?.publicUrl ?? ''}
            placeholder="https://rdp.labforge.example.com"
            help="Base URL students reach the Guacamole web client at."
            required
          />
          <Field
            label="user-mapping.xml path"
            name="userMappingPath"
            defaultValue={cfg?.userMappingPath ?? ''}
            placeholder="/opt/guacamole/user-mapping.xml"
            help="Filesystem path on the host running Guacamole (or the SSH target below)."
            required
          />
          <Field
            label="Default RDP host (fallback)"
            name="defaultRdpHost"
            defaultValue={cfg?.defaultRdpHost ?? ''}
            placeholder="80.243.180.81"
            help="Used when a node has no proxyHost set. Usually the public IP of the worker that runs Windows labs."
          />
          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              value="1"
              defaultChecked={cfg?.enabled ?? true}
              className="h-4 w-4"
            />
            <span>Gateway enabled (redeem will redirect through Guacamole)</span>
          </label>
        </div>

        <details className="rounded-lg border border-ink-200 p-3" open={remote}>
          <summary className="cursor-pointer text-sm font-medium">
            Remote-write (SSH to Guacamole host)
          </summary>
          <p className="mt-2 text-xs text-ink-600">
            Leave the SSH fields empty when the control-plane runs on the
            same host as Guacamole — the file is written directly. Fill
            them in to ship the rendered XML over SSH instead.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                name="remoteWrite"
                value="1"
                defaultChecked={remote}
                className="h-4 w-4"
              />
              <span>Write user-mapping.xml over SSH</span>
            </label>
            <Field label="Host" name="sshHost" defaultValue={cfg?.sshHost ?? ''} />
            <Field label="User" name="sshUser" defaultValue={cfg?.sshUser ?? ''} />
            <Field
              label="Port"
              name="sshPort"
              type="number"
              defaultValue={String(cfg?.sshPort ?? 22)}
            />
            <Field
              label="Key path (on control-plane host)"
              name="sshKeyPath"
              defaultValue={cfg?.sshKeyPath ?? ''}
            />
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-ink-800">
                Password (leave blank to keep stored)
              </label>
              <input
                type="password"
                name="sshPassword"
                autoComplete="new-password"
                className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm"
              />
              <label className="mt-1 inline-flex items-center gap-2 text-xs text-ink-600">
                <input type="checkbox" name="sshPasswordClear" value="1" /> Clear stored password
              </label>
            </div>
          </div>
        </details>

        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary">
            Save configuration
          </button>
          {cfg && (
            <span className="text-xs text-ink-500">
              Last updated {new Date(cfg.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </form>

      <form action={resyncMapping} className="card space-y-2">
        <div className="text-sm font-semibold">Resync user-mapping.xml</div>
        <p className="text-xs text-ink-600">
          Re-renders the file from the current set of live instances and
          ships it (locally or over SSH). Run this if an out-of-band edit
          drifted the file or after fixing a transient SSH outage.
        </p>
        <button type="submit" className="btn-secondary text-sm">
          Resync now
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  help,
  required,
  type = 'text',
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink-800">{label}</label>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm"
      />
      {help && <p className="mt-1 text-xs text-ink-500">{help}</p>}
    </div>
  );
}
