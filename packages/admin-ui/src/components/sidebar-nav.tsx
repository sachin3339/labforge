'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IconHome,
  IconTemplate,
  IconUsers,
  IconServer,
  IconChart,
  IconSettings,
  IconBolt,
} from './icons';

const items = [
  { href: '/dashboard', label: 'Overview', Icon: IconHome },
  { href: '/dashboard/templates', label: 'Templates', Icon: IconTemplate },
  { href: '/dashboard/batches', label: 'Batches', Icon: IconUsers },
  { href: '/dashboard/instances', label: 'Live labs', Icon: IconServer },
  { href: '/dashboard/reports', label: 'Reports', Icon: IconChart },
  { href: '/dashboard/settings', label: 'Settings', Icon: IconSettings },
];

const platformItems = [
  { href: '/dashboard/platform/tenants', label: 'Tenants', Icon: IconBolt },
  { href: '/dashboard/platform/nodes', label: 'Nodes', Icon: IconServer },
];

export function SidebarNav({ isPlatform = false }: { isPlatform?: boolean }) {
  const pathname = usePathname() || '';

  const renderItem = (it: { href: string; label: string; Icon: typeof IconHome }) => {
    const active =
      it.href === '/dashboard'
        ? pathname === '/dashboard'
        : pathname === it.href || pathname.startsWith(it.href + '/');
    return (
      <Link
        key={it.href}
        href={it.href}
        aria-current={active ? 'page' : undefined}
        className={
          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ' +
          (active
            ? 'bg-brand-50 text-brand-700'
            : 'text-ink-700 hover:bg-ink-100 hover:text-ink-900')
        }
      >
        <span
          className={
            active
              ? 'text-brand-600'
              : 'text-ink-500 group-hover:text-ink-700'
          }
        >
          <it.Icon size={18} />
        </span>
        {it.label}
      </Link>
    );
  };

  return (
    <nav className="flex-1 space-y-0.5 p-3">
      {items.map(renderItem)}
      {isPlatform && (
        <>
          <div className="mt-4 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500 border-t border-ink-200/70">
            Platform
          </div>
          {platformItems.map(renderItem)}
        </>
      )}
    </nav>
  );
}
