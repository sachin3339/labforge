import Link from 'next/link';

type Tab = { href: string; label: string };

const TABS: Tab[] = [
  { href: '/dashboard/reports', label: 'Usage' },
  { href: '/dashboard/reports/templates', label: 'By template' },
  { href: '/dashboard/reports/cost', label: 'Cost & margin' },
  { href: '/dashboard/reports/students', label: 'Students' },
  { href: '/dashboard/reports/capacity', label: 'Capacity' },
];

export function ReportTabs({ active }: { active: string }) {
  return (
    <nav className="flex flex-wrap gap-1 border-b border-ink-100 text-sm">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-2 ${
            t.href === active
              ? 'border-brand text-brand'
              : 'border-transparent text-ink-900/60 hover:text-ink-900'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Date-window picker. Renders <input type="date"> for from + to.
 * Submits via GET so the URL captures the chosen window.
 */
export function WindowPicker({
  from,
  to,
}: {
  from?: string;
  to?: string;
}) {
  return (
    <form className="flex flex-wrap items-end gap-3 text-xs">
      <label className="flex flex-col text-ink-900/70">
        From
        <input
          type="date"
          name="from"
          defaultValue={from ?? ''}
          className="mt-1 rounded border border-ink-200 px-2 py-1"
        />
      </label>
      <label className="flex flex-col text-ink-900/70">
        To
        <input
          type="date"
          name="to"
          defaultValue={to ?? ''}
          className="mt-1 rounded border border-ink-200 px-2 py-1"
        />
      </label>
      <button className="btn-secondary text-xs" type="submit">
        Apply
      </button>
      <span className="text-[10px] text-ink-900/40">
        defaults: last 30 days
      </span>
    </form>
  );
}

/** Tiny pure-CSS bar chart — avoids pulling in a chart library. */
export function BarChart({
  data,
  height = 160,
}: {
  data: Array<{ label: string; value: number; secondary?: number }>;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.secondary ?? 0)));
  return (
    <div
      className="flex items-end gap-1 overflow-x-auto rounded-md border border-ink-100 bg-white p-3"
      style={{ height }}
    >
      {data.length === 0 ? (
        <div className="m-auto text-xs text-ink-900/40">No data</div>
      ) : (
        data.map((d) => (
          <div
            key={d.label}
            className="flex min-w-[12px] flex-col items-center justify-end"
            title={`${d.label}: ${d.value}${d.secondary !== undefined ? ` (${d.secondary} redeemed)` : ''}`}
          >
            {d.secondary !== undefined && (
              <div
                className="w-2 bg-green-500"
                style={{ height: `${(d.secondary / max) * (height - 40)}px` }}
              />
            )}
            <div
              className="w-3 bg-brand"
              style={{ height: `${(d.value / max) * (height - 40)}px` }}
            />
            <div className="mt-1 rotate-[-45deg] origin-top-left whitespace-nowrap text-[9px] text-ink-900/50">
              {d.label.slice(5)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
