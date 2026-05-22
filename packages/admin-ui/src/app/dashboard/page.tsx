import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import {
  IconTemplate,
  IconServer,
  IconActivity,
  IconChart,
  IconExternal,
} from '@/components/icons';
import type { ComponentType } from 'react';

type Me = {
  tenant: { id: string; name: string };
  stats: { templates: number; activeInstances: number; launchesLast24h: number };
};

type IconProps = { size?: number; className?: string };

export default async function OverviewPage() {
  const res = await apiFetch<Me>('/api/v1/admin/me');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const s = res.data.stats;

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-1">
        <div className="text-[11px] uppercase tracking-[0.16em] text-ink-500">
          Tenant overview
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink-900">
          Welcome back, <span className="text-brand-700">{res.data.tenant.name}</span>
        </h1>
        <p className="text-sm text-ink-600">
          A snapshot of templates, active labs, and recent launch activity.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          label="Templates"
          value={s.templates}
          href="/dashboard/templates"
          tint="brand"
          Icon={IconTemplate}
          hint="Lab images & resources"
        />
        <Stat
          label="Active labs"
          value={s.activeInstances}
          href="/dashboard/instances"
          tint="emerald"
          Icon={IconServer}
          hint="Running right now"
        />
        <Stat
          label="Launches (24h)"
          value={s.launchesLast24h}
          href="/dashboard/reports"
          tint="sky"
          Icon={IconActivity}
          hint="Last 24 hours"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <IconChart size={18} className="text-brand-600" />
            Get started
          </h2>
          <ol className="mt-4 space-y-3 text-sm text-ink-700">
            <Step n={1}>
              Create a{' '}
              <Link className="font-medium text-brand-700 underline-offset-2 hover:underline" href="/dashboard/templates">
                lab template
              </Link>{' '}
              describing the container image, ports, and resources.
            </Step>
            <Step n={2}>
              From your LMS or backend, call{' '}
              <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[12px] font-mono text-ink-800">POST /api/v1/launches</code>{' '}
              with the template id and a user id.
            </Step>
            <Step n={3}>
              Redirect the student to the returned <code className="rounded bg-ink-100 px-1.5 py-0.5 text-[12px] font-mono text-ink-800">launchUrl</code>. The lab opens in their browser.
            </Step>
          </ol>
        </div>

        <div className="card flex flex-col gap-3">
          <h2 className="text-base font-semibold">Quick actions</h2>
          <QuickLink href="/dashboard/templates" label="Browse templates" />
          <QuickLink href="/dashboard/batches" label="Manage batches" />
          <QuickLink href="/dashboard/instances" label="Live labs" />
          <QuickLink href="/dashboard/reports" label="View reports" />
        </div>
      </div>
    </div>
  );
}

const TINTS: Record<string, { ring: string; iconBg: string; iconFg: string }> = {
  brand: {
    ring: 'hover:border-brand-300',
    iconBg: 'bg-brand-50',
    iconFg: 'text-brand-600',
  },
  emerald: {
    ring: 'hover:border-emerald-300',
    iconBg: 'bg-emerald-50',
    iconFg: 'text-emerald-600',
  },
  sky: {
    ring: 'hover:border-sky-300',
    iconBg: 'bg-sky-50',
    iconFg: 'text-sky-600',
  },
};

function Stat({
  label,
  value,
  href,
  tint,
  Icon,
  hint,
}: {
  label: string;
  value: number;
  href: string;
  tint: keyof typeof TINTS;
  Icon: ComponentType<IconProps>;
  hint?: string;
}) {
  const t = TINTS[tint];
  return (
    <Link
      href={href}
      className={`card group relative overflow-hidden transition hover:shadow-elevated ${t.ring}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-500">
            {label}
          </div>
          <div className="mt-2 text-3xl font-semibold tabular-nums text-ink-900">
            {value.toLocaleString()}
          </div>
          {hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${t.iconBg} ${t.iconFg}`}>
          <Icon size={20} />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-1 text-xs font-medium text-ink-500 group-hover:text-brand-700">
        View details
        <span className="transition group-hover:translate-x-0.5">→</span>
      </div>
    </Link>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between rounded-lg border border-ink-200/70 px-3 py-2 text-sm text-ink-700 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700"
    >
      <span>{label}</span>
      <IconExternal size={14} className="text-ink-400 group-hover:text-brand-600" />
    </Link>
  );
}
