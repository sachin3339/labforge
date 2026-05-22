import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ReactNode } from 'react';
import { ADMIN_COOKIE_NAME, apiFetch } from '@/lib/api';
import { SidebarNav } from '@/components/sidebar-nav';
import {
  IconHome,
  IconTemplate,
  IconUsers,
  IconServer,
  IconChart,
  IconSettings,
  IconLogout,
  IconBolt,
} from '@/components/icons';

type Me = { tenant: { id: string; name: string } };

async function signOut() {
  'use server';
  const store = await cookies();
  store.delete(ADMIN_COOKIE_NAME);
  redirect('/login');
}

const navItems = [
  { href: '/dashboard', label: 'Overview', Icon: IconHome },
  { href: '/dashboard/templates', label: 'Templates', Icon: IconTemplate },
  { href: '/dashboard/batches', label: 'Batches', Icon: IconUsers },
  { href: '/dashboard/instances', label: 'Live labs', Icon: IconServer },
  { href: '/dashboard/reports', label: 'Reports', Icon: IconChart },
  { href: '/dashboard/settings', label: 'Settings', Icon: IconSettings },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const me = await apiFetch<Me>('/api/v1/admin/me');
  if (!me.ok) redirect('/login');

  const initial = (me.data.tenant.name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-ink-200/70 bg-white/80 backdrop-blur-sm md:flex">
        <div className="flex h-16 items-center gap-2 px-5 border-b border-ink-200/70">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white shadow-card">
            <IconBolt size={18} />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">LabForge</div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-500">
              Admin console
            </div>
          </div>
        </div>

        <SidebarNav items={navItems} />

        <div className="border-t border-ink-200/70 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-ink-900 text-sm font-semibold text-white">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink-900">
                {me.data.tenant.name}
              </div>
              <div className="truncate text-[10px] text-ink-500">
                Tenant · {me.data.tenant.id.slice(0, 8)}…
              </div>
            </div>
            <form action={signOut}>
              <button
                type="submit"
                className="grid h-8 w-8 place-items-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900"
                title="Sign out"
                aria-label="Sign out"
              >
                <IconLogout size={16} />
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top-bar */}
        <header className="flex h-14 items-center justify-between border-b border-ink-200/70 bg-white/80 px-4 backdrop-blur-sm md:hidden">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 text-white">
              <IconBolt size={16} />
            </span>
            <span className="text-sm font-semibold">LabForge</span>
          </div>
          <form action={signOut}>
            <button type="submit" className="btn-ghost text-xs">
              Sign out
            </button>
          </form>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-10 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
