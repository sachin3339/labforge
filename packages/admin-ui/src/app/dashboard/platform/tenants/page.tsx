import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';

type TenantRow = {
  id: string;
  name: string;
  apiKey: string;
  role: string;
  createdAt: string;
  _count: { templates: number; instances: number; launches: number };
};

async function createTenant(formData: FormData) {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  await apiFetch('/api/v1/platform/tenants', {
    method: 'POST',
    body: JSON.stringify({ name, role: 'tenant' }),
  });
  revalidatePath('/dashboard/platform/tenants');
}

async function rotateKey(id: string) {
  'use server';
  await apiFetch(`/api/v1/platform/tenants/${id}/rotate-key`, { method: 'POST' });
  revalidatePath('/dashboard/platform/tenants');
}

async function deleteTenant(id: string) {
  'use server';
  await apiFetch(`/api/v1/platform/tenants/${id}`, { method: 'DELETE' });
  revalidatePath('/dashboard/platform/tenants');
}

export default async function PlatformTenantsPage() {
  const res = await apiFetch<{ tenants: TenantRow[] }>('/api/v1/platform/tenants');
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
  const tenants = res.data.tenants;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="eyebrow">Platform</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Tenants</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600">
          Clients integrating with the LabForge API. Each tenant gets a unique
          API key for programmatic access.
        </p>
      </header>

      <form action={createTenant} className="card flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs font-medium text-ink-900/70">Tenant name</label>
          <input
            name="name"
            type="text"
            required
            placeholder="Mercedes-Benz Training"
            className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm"
          />
        </div>
        <button type="submit" className="btn-primary">
          Create tenant
        </button>
      </form>

      {tenants.length === 0 ? (
        <div className="card text-center text-sm text-ink-900/60">
          No tenants yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">API key</th>
                <th className="px-4 py-3">Usage</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-t border-ink-100 align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-ink-900/60">{t.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ' +
                        (t.role === 'platform'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-ink-100 text-ink-700')
                      }
                    >
                      {t.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <code className="block max-w-xs truncate rounded bg-ink-50 px-2 py-1 font-mono text-[11px]">
                      {t.apiKey}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-900/70">
                    <div>{t._count.templates} templates</div>
                    <div>{t._count.instances} instances</div>
                    <div>{t._count.launches} launches</div>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    <Link
                      href={`/dashboard/platform/tenants/${t.id}`}
                      className="btn-secondary text-xs"
                    >
                      Details
                    </Link>
                    <form action={rotateKey.bind(null, t.id)} className="inline">
                      <button type="submit" className="btn-secondary text-xs">
                        Rotate key
                      </button>
                    </form>
                    {t.role !== 'platform' && (
                      <form action={deleteTenant.bind(null, t.id)} className="inline">
                        <button
                          type="submit"
                          className="btn-secondary text-xs text-red-600 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
