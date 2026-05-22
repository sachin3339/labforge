import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ReactNode } from 'react';
import { ADMIN_COOKIE_NAME, apiFetch } from '@/lib/api';

type Me = { tenant: { id: string; name: string } };

async function signOut() {
  'use server';
  const store = await cookies();
  store.delete(ADMIN_COOKIE_NAME);
  redirect('/login');
}

const navItems = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/templates', label: 'Templates' },
  { href: '/dashboard/batches', label: 'Batches' },
  { href: '/dashboard/instances', label: 'Live labs' },
  { href: '/dashboard/settings', label: 'Settings' },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const me = await apiFetch<Me>('/api/v1/admin/me');
  if (!me.ok) redirect('/login');

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-100 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <div className="font-semibold tracking-tight">LabForge</div>
            <nav className="flex gap-1 text-sm">
              {navItems.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  className="rounded-md px-3 py-1.5 hover:bg-ink-50"
                >
                  {it.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-ink-900/60">{me.data.tenant.name}</span>
            <form action={signOut}>
              <button className="btn-secondary text-xs" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
