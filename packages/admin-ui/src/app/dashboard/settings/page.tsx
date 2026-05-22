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
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-900/60">Manage tenant credentials.</p>
      </header>

      <section className="card space-y-3">
        <h2 className="text-base font-semibold">Tenant</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-ink-900/60">Name</dt>
          <dd>{me.data.tenant.name}</dd>
          <dt className="text-ink-900/60">Tenant ID</dt>
          <dd className="font-mono text-xs">{me.data.tenant.id}</dd>
        </dl>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-semibold">API key</h2>
        <p className="text-sm text-ink-900/60">
          Rotating the key invalidates the current one immediately. Update any
          LMS integrations afterwards.
        </p>
        <form action={rotateKey}>
          <button className="btn-danger" type="submit">
            Rotate API key
          </button>
        </form>
      </section>
    </div>
  );
}
