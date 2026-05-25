import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { consumeFlash } from '@/lib/flash';
import { SubmitButton } from '@/components/submit-button';
import {
  IconUsers,
  IconPencil,
  IconTrash,
  IconExternal,
} from '@/components/icons';
import { renameBatchAction, purgeBatchAction } from './actions';

type BatchSummary = {
  batchId: string;
  label: string;
  templateId: string;
  templateName: string;
  count: number;
  redeemed: number;
  active: number;
  createdAt: string;
  expiresAt: string;
};

type Msg = { message: string };

export default async function BatchesPage({
  searchParams,
}: {
  searchParams?: Promise<{ edit?: string }>;
}) {
  const sp = searchParams ? await searchParams : undefined;
  const editingId = sp?.edit ?? null;

  const info = await consumeFlash<Msg>('batch-info');
  const err = !info ? await consumeFlash<Msg>('batch-error') : null;

  const res = await apiFetch<{ batches: BatchSummary[] }>('/api/v1/batches');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const batches = res.data.batches;

  // Roll-up across all batches so the page leads with the same kind of
  // at-a-glance summary the instances page does.
  const totals = batches.reduce(
    (acc, b) => {
      acc.batches += 1;
      acc.seats += b.count;
      acc.redeemed += b.redeemed;
      acc.active += b.active;
      return acc;
    },
    { batches: 0, seats: 0, redeemed: 0, active: 0 },
  );

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow">Distribution</div>
            <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <IconUsers size={22} className="text-brand-600" />
              Batches
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-600">
              Pre-issued bulk launch URLs handed off to clients (e.g. 50 seats
              for one cohort). Each URL is single-use; redeemed URLs become
              live lab sessions.
            </p>
          </div>
          <Link href="/dashboard/batches/new" className="btn-primary">
            New batch
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Batches" value={totals.batches} tone="text-brand-500" />
        <Tile label="Total seats" value={totals.seats} tone="text-ink-500" />
        <Tile
          label="Redeemed"
          value={totals.redeemed}
          tone="text-sky-500"
          subtle={
            totals.seats
              ? `${Math.round((totals.redeemed / totals.seats) * 100)}% of seats`
              : undefined
          }
        />
        <Tile
          label="Active labs"
          value={totals.active}
          tone="text-emerald-500"
          live
        />
      </div>

      {info && <div className="banner-success">{info.message}</div>}
      {err && <div className="banner-error">{err.message}</div>}

      {batches.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">
            <IconUsers size={20} />
          </div>
          <div className="text-sm font-medium text-ink-800">No batches yet</div>
          <div className="text-xs text-ink-500">
            Click <strong>New batch</strong> to issue seats for a cohort.
          </div>
        </div>
      ) : (
        <div className="table-wrap scroll-pretty overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Label</th>
                <th>Template</th>
                <th>Seats</th>
                <th>Redeemed</th>
                <th>Active</th>
                <th>Expires</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const isEditing = editingId === b.batchId;
                const redeemedPct = b.count
                  ? Math.round((b.redeemed / b.count) * 100)
                  : 0;
                return (
                  <tr key={b.batchId} className="align-top">
                    <td>
                      {isEditing ? (
                        <form
                          action={renameBatchAction}
                          className="flex flex-col gap-1.5"
                        >
                          <input type="hidden" name="batchId" value={b.batchId} />
                          <input
                            name="label"
                            defaultValue={b.label}
                            required
                            maxLength={200}
                            autoFocus
                            className="rounded-md border border-brand-300 px-2 py-1 text-sm shadow-focus focus:outline-none"
                          />
                          <div className="flex items-center gap-2">
                            <SubmitButton variant="primary" pendingLabel="Saving…">
                              Save
                            </SubmitButton>
                            <Link
                              href="/dashboard/batches"
                              className="btn-ghost text-xs"
                            >
                              Cancel
                            </Link>
                          </div>
                          <div className="font-mono text-[11px] text-ink-500">
                            {b.batchId}
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="font-medium text-ink-900">{b.label}</div>
                          <div className="font-mono text-[11px] text-ink-500">
                            {b.batchId}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="text-sm text-ink-800">{b.templateName}</td>
                    <td className="tabular-nums">{b.count}</td>
                    <td className="min-w-[140px]">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-100">
                          <div
                            className="h-full bg-gradient-to-r from-sky-400 to-brand-500"
                            style={{ width: `${redeemedPct}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-ink-700">
                          {b.redeemed}/{b.count}
                        </span>
                      </div>
                    </td>
                    <td>
                      {b.active > 0 ? (
                        <span className="badge badge-muted">
                          <span className="dot-emerald dot-pulse" />
                          {b.active}
                        </span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="text-xs text-ink-600">
                      {new Date(b.expiresAt).toLocaleString()}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Link
                          href={`/dashboard/batches/${b.batchId}`}
                          className="btn-secondary text-xs"
                        >
                          <IconExternal size={12} />
                          View URLs
                        </Link>
                        {!isEditing && (
                          <Link
                            href={`/dashboard/batches?edit=${b.batchId}`}
                            className="btn-ghost text-xs"
                            title="Rename this batch"
                          >
                            <IconPencil size={12} />
                            Edit
                          </Link>
                        )}
                        {/* Native <details> dropdown — works without client
                            JS so the page stays a pure server component. */}
                        <details className="relative">
                          <summary
                            className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40"
                            title="Terminate instances and remove this batch"
                          >
                            <IconTrash size={12} />
                            Delete
                          </summary>
                          <div className="absolute right-0 z-20 mt-1.5 w-80 rounded-xl border border-ink-200 bg-white p-4 text-left shadow-elevated">
                            <form
                              action={purgeBatchAction}
                              className="space-y-3"
                            >
                              <input
                                type="hidden"
                                name="batchId"
                                value={b.batchId}
                              />
                              <div className="flex items-start gap-2">
                                <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-red-50 text-red-600">
                                  <IconTrash size={14} />
                                </div>
                                <div className="text-xs leading-relaxed text-ink-800">
                                  Terminate all{' '}
                                  <strong>{b.active}</strong> live instance
                                  {b.active === 1 ? '' : 's'} and remove all{' '}
                                  <strong>{b.count}</strong> seats for{' '}
                                  <span className="font-medium">
                                    {b.label}
                                  </span>
                                  . This cannot be undone.
                                </div>
                              </div>
                              <label className="block text-[11px] font-medium uppercase tracking-wide text-ink-500">
                                Type <span className="font-mono normal-case">DELETE</span>{' '}
                                to confirm
                                <input
                                  name="confirm"
                                  required
                                  pattern="DELETE"
                                  placeholder="DELETE"
                                  className="mt-1 w-full rounded-md border border-ink-200 px-2 py-1.5 text-sm font-mono text-ink-900 placeholder:text-ink-400 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/25"
                                />
                              </label>
                              <div className="flex justify-end">
                                <SubmitButton
                                  variant="danger"
                                  pendingLabel="Deleting…"
                                >
                                  Delete batch
                                </SubmitButton>
                              </div>
                            </form>
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  subtle,
  live = false,
}: {
  label: string;
  value: number;
  tone: string;
  subtle?: string;
  live?: boolean;
}) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="kpi-label text-ink-500">{label}</div>
        {live && value > 0 && (
          <span className="dot-emerald dot-pulse" aria-label="live" />
        )}
      </div>
      <div className="kpi-value">{value.toLocaleString()}</div>
      {subtle && <div className="kpi-hint">{subtle}</div>}
    </div>
  );
}
