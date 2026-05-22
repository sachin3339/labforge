import Link from 'next/link';
import { apiFetch } from '@/lib/api';

type Me = {
  tenant: { id: string; name: string };
  stats: { templates: number; activeInstances: number; launchesLast24h: number };
};

export default async function OverviewPage() {
  const res = await apiFetch<Me>('/api/v1/admin/me');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const s = res.data.stats;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-ink-900/60">
          What&apos;s happening in <strong>{res.data.tenant.name}</strong>.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Templates" value={s.templates} href="/dashboard/templates" />
        <Stat
          label="Active labs"
          value={s.activeInstances}
          href="/dashboard/instances"
        />
        <Stat
          label="Launches (24h)"
          value={s.launchesLast24h}
          href="/dashboard/instances"
        />
      </div>
      <div className="card">
        <h2 className="text-base font-semibold">Get started</h2>
        <ol className="mt-3 space-y-2 text-sm text-ink-900/80">
          <li>
            1. Create a <Link className="text-brand-600 underline" href="/dashboard/templates">lab template</Link>{' '}
            describing the container image, ports, and resources.
          </li>
          <li>
            2. From your LMS or backend, call <code className="rounded bg-ink-50 px-1 py-0.5">POST /api/v1/launches</code>{' '}
            with the template id and a user id.
          </li>
          <li>
            3. Redirect the student to the returned <code>launchUrl</code>. The lab opens in their browser.
          </li>
        </ol>
      </div>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link
      href={href}
      className="card transition hover:border-brand-500 hover:shadow"
    >
      <div className="text-sm text-ink-900/60">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
    </Link>
  );
}
