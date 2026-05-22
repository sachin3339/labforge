'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType } from 'react';

type IconProps = { size?: number; className?: string };
type Item = { href: string; label: string; Icon: ComponentType<IconProps> };

export function SidebarNav({ items }: { items: Item[] }) {
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
