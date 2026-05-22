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
} from './icons';

const items = [
  { href: '/dashboard', label: 'Overview', Icon: IconHome },
  { href: '/dashboard/templates', label: 'Templates', Icon: IconTemplate },
  { href: '/dashboard/batches', label: 'Batches', Icon: IconUsers },
  { href: '/dashboard/instances', label: 'Live labs', Icon: IconServer },
  { href: '/dashboard/reports', label: 'Reports', Icon: IconChart },
  { href: '/dashboard/settings', label: 'Settings', Icon: IconSettings },
];

export function SidebarNav() {
  const pathname = usePathname() || '';

  return (
    <nav className="flex-1 space-y-0.5 p-3">
      {items.map((it) => {
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
      })}
    </nav>
  );
}
