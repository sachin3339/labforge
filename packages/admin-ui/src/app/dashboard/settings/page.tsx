import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ADMIN_COOKIE_NAME, apiFetch } from '@/lib/api';

type RotateResult = { apiKey: string };

async function rotateKey() {
  'use server';
  const res = await apiFetch<RotateResult>('/api/v1/admin/rotate-key', {
    method: 'POST',
  });
  if (!res.ok) return;
  const store = await cookies();
  store.set(ADMIN_COOKIE_NAME, res.data.apiKey, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  revalidatePath('/dashboard/settings');
}

export default async function SettingsPage() {
  const me = await apiFetch<{ tenant: { id: string; name: string } }>(
    '/api/v1/admin/me',
  );
  if (!me.ok) return <div className="text-red-600">Error: {me.error}</div>;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="eyebrow">Account</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-600">
          Manage tenant credentials and integration access.
        </p>
      </header>

      <section className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Tenant</h2>
          <span className="badge badge-muted">Read only</span>
        </div>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-ink-500">Name</dt>
          <dd className="font-medium text-ink-900">{me.data.tenant.name}</dd>
          <dt className="text-ink-500">Tenant ID</dt>
          <dd className="font-mono text-xs text-ink-700">{me.data.tenant.id}</dd>
        </dl>
      </section>

      {/* Danger zone — visually separated so destructive actions don't blend
          in with read-only tenant info above. */}
      <section className="rounded-xl border border-red-200/80 bg-red-50/40 p-5 shadow-card">
        <div className="flex items-center gap-2">
          <span className="badge badge-danger">Danger zone</span>
          <h2 className="text-base font-semibold text-red-900">API key</h2>
        </div>
        <p className="mt-2 text-sm text-red-900/80">
          Rotating the key invalidates the current one immediately. Any LMS or
          backend integration that still uses the old key will stop working
          until you update its configuration.
        </p>
        <form action={rotateKey} className="mt-3">
          <button className="btn-danger" type="submit">
            Rotate API key
          </button>
        </form>
      </section>
    </div>
  );
}
