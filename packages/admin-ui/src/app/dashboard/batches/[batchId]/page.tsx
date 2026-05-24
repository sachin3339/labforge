import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { consumeFlash } from '@/lib/flash';
import { SubmitButton } from '@/components/submit-button';
import {
  revokeLaunchAction,
  regenerateLaunchAction,
  extendBatchAction,
  terminateBatchAction,
  addSeatsAction,
  prepareLaunchAction,
  prepareBatchAction,
  openLaunchAction,
} from './actions';

type BatchDetail = {
  batchId: string;
  label: string;
  templateId: string;
  templateName: string;
  createdAt: string;
  expiresAt: string;
  seats: {
    launchId: string;
    seat: number;
    displayName: string;
    redeemed: string | null;
    revoked?: boolean;
    instance: {
      id: string;
      subdomain: string;
      status: string;
      lastSeenAt: string | null;
      node: { id: string; name: string } | null;
    } | null;
  }[];
};

type FreshUrls = {
  title: string;
  urls: Array<{
    launchId: string;
    launchUrl: string;
    expiresAt: string;
    displayName?: string;
    seat?: number;
  }>;
};

type Msg = { message: string };

const STATUS_TONE: Record<string, string> = {
  ready: 'bg-green-100 text-green-800',
  idle: 'bg-amber-100 text-amber-800',
  pending: 'bg-blue-100 text-blue-800',
  provisioning: 'bg-blue-100 text-blue-800',
  paused: 'bg-purple-100 text-purple-800',
  terminating: 'bg-ink-100 text-ink-900/70',
  terminated: 'bg-ink-100 text-ink-900/50',
  failed: 'bg-red-100 text-red-800',
  'not-redeemed': 'bg-ink-50 text-ink-900/60',
};

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;

  const fresh = await consumeFlash<FreshUrls>('batch-fresh-urls');
  const info = !fresh ? await consumeFlash<Msg>('batch-info') : null;
  const err = !fresh && !info ? await consumeFlash<Msg>('batch-error') : null;

  const res = await apiFetch<BatchDetail>(`/api/v1/batches/${batchId}`);
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const b = res.data;
  const redeemed = b.seats.filter((s) => s.redeemed).length;
  const liveCount = b.seats.filter(
    (s) => s.instance && !['terminated', 'failed'].includes(s.instance.status),
  ).length;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{b.label}</h1>
            <p className="text-sm text-ink-900/60">
              Template <strong>{b.templateName}</strong> · {b.seats.length}{' '}
              seats · {redeemed} redeemed · {liveCount} live · expires{' '}
              {new Date(b.expiresAt).toLocaleString()}
            </p>
          </div>
          <Link href="/dashboard/batches" className="btn-secondary text-sm">
            ← All batches
          </Link>
        </div>
      </header>

      {fresh && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">{fresh.title}</h2>
          <p className="mt-1 text-xs text-amber-800">
            These URLs grant single-use access. Distribute them now — the system will not redisplay them.
          </p>
          <ol className="mt-3 space-y-2">
            {fresh.urls.map((u) => (
              <li
                key={u.launchId}
                className="rounded border border-amber-200 bg-white p-2"
              >
                <div className="text-xs font-medium">
                  {u.displayName ?? u.launchId}
                  {u.seat ? <span className="text-ink-900/50"> · seat {u.seat}</span> : null}
                </div>
                <code className="mt-1 block break-all font-mono text-[11px] text-ink-900/80">
                  {u.launchUrl}
                </code>
                <div className="mt-1 text-[10px] text-ink-900/50">
                  expires {new Date(u.expiresAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {info && (
        <div className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {info.message}
        </div>
      )}
      {err && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {err.message}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <form action={prepareBatchAction} className="card space-y-2">
          <h3 className="text-sm font-semibold">Prepare all seats</h3>
          <input type="hidden" name="batchId" value={batchId} />
          <label className="flex items-center gap-2 text-xs">
            Concurrency
            <input
              type="number"
              name="concurrency"
              defaultValue={5}
              min={1}
              max={20}
              className="w-24 rounded border border-ink-200 px-2 py-1"
            />
          </label>
          <p className="text-[10px] text-ink-900/50">
            Pre-provisions every seat so students hit a warm lab. Skips seats
            already live; resumes paused ones.
          </p>
          <SubmitButton variant="secondary" pendingLabel="Preparing batch…">
            Prepare batch
          </SubmitButton>
        </form>

        <form action={extendBatchAction} className="card space-y-2">
          <h3 className="text-sm font-semibold">Extend batch</h3>
          <input type="hidden" name="batchId" value={batchId} />
          <label className="flex items-center gap-2 text-xs">
            Hours
            <input
              type="number"
              name="extendHours"
              defaultValue={24}
              min={1}
              max={8760}
              className="w-24 rounded border border-ink-200 px-2 py-1"
            />
          </label>
          <p className="text-[10px] text-ink-900/50">
            Does not re-sign JWTs. Long extensions past the original token
            window need <em>Regenerate</em> per seat.
          </p>
          <SubmitButton variant="secondary" pendingLabel="Extending…">
            Extend all seats
          </SubmitButton>
        </form>

        <form action={addSeatsAction} className="card space-y-2">
          <h3 className="text-sm font-semibold">Add seats</h3>
          <input type="hidden" name="batchId" value={batchId} />
          <label className="flex items-center gap-2 text-xs">
            Count
            <input
              type="number"
              name="count"
              defaultValue={1}
              min={1}
              max={500}
              className="w-24 rounded border border-ink-200 px-2 py-1"
            />
          </label>
          <p className="text-[10px] text-ink-900/50">
            New URLs are shown once after creation.
          </p>
          <SubmitButton variant="secondary" pendingLabel="Minting seats…">
            Mint seats
          </SubmitButton>
        </form>

        <form action={terminateBatchAction} className="card space-y-2 border-red-200">
          <h3 className="text-sm font-semibold text-red-700">Terminate batch</h3>
          <input type="hidden" name="batchId" value={batchId} />
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" name="deleteVolumes" value="1" />
            Also delete volumes (irreversible)
          </label>
          <p className="text-[10px] text-ink-900/50">
            Stops every live lab and revokes all seat URLs.
          </p>
          <SubmitButton
            variant="danger"
            pendingLabel="Terminating…"
          >
            Terminate batch
          </SubmitButton>
        </form>
      </section>

      <div className="rounded-md bg-ink-50 px-4 py-3 text-sm text-ink-900/70">
        Per-seat status. The original launch URLs are not shown — use{' '}
        <strong>Regenerate</strong> on any seat that needs a fresh URL.
      </div>

      <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
            <tr>
              <th className="px-3 py-2 w-12">#</th>
              <th className="px-3 py-2">Seat</th>
              <th className="px-3 py-2">Redeemed</th>
              <th className="px-3 py-2">Lab</th>
              <th className="px-3 py-2">Node</th>
              <th className="px-3 py-2">Last seen</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {b.seats.map((s) => {
              const status = s.instance?.status ?? 'not-redeemed';
              return (
                <tr key={s.launchId} className="border-t border-ink-100 align-top">
                  <td className="px-3 py-2 text-xs text-ink-900/60">{s.seat}</td>
                  <td className="px-3 py-2">{s.displayName}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.redeemed ? new Date(s.redeemed).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={`rounded-full px-2 py-0.5 ${STATUS_TONE[status] ?? 'bg-ink-50'}`}
                    >
                      {status}
                    </span>
                    {s.instance && (
                      <Link
                        href={`/dashboard/instances/${s.instance.id}`}
                        className="ml-2 text-brand hover:underline font-mono"
                      >
                        {s.instance.subdomain}
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {s.instance?.node ? (
                      <span
                        className="badge bg-sky-100 text-sky-800"
                        title="Physical host running this container"
                      >
                        {s.instance.node.name}
                      </span>
                    ) : (
                      <span className="text-ink-900/40">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-900/60">
                    {s.instance?.lastSeenAt
                      ? new Date(s.instance.lastSeenAt).toLocaleString()
                      : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {!s.revoked && (
                        <form action={openLaunchAction}>
                          <input type="hidden" name="launchId" value={s.launchId} />
                          <input type="hidden" name="batchId" value={batchId} />
                          <SubmitButton
                            variant="success"
                            pendingLabel="Opening…"
                            title="Open the lab in a new context (admin preview). Doesn't affect the student URL."
                          >
                            Open lab
                          </SubmitButton>
                        </form>
                      )}
                      {(!s.instance ||
                        ['terminated', 'failed', 'paused'].includes(
                          s.instance.status,
                        )) && (
                        <form action={prepareLaunchAction}>
                          <input type="hidden" name="launchId" value={s.launchId} />
                          <input type="hidden" name="batchId" value={batchId} />
                          <SubmitButton
                            variant="success"
                            pendingLabel={
                              s.instance?.status === 'paused'
                                ? 'Resuming…'
                                : 'Preparing…'
                            }
                            title={
                              s.instance?.status === 'paused'
                                ? 'Resume the paused container so students hit a warm lab.'
                                : 'Pre-provision the lab so the student does not wait on cold start.'
                            }
                          >
                            {s.instance?.status === 'paused' ? 'Resume' : 'Prepare'}
                          </SubmitButton>
                        </form>
                      )}
                      <form action={revokeLaunchAction}>
                        <input type="hidden" name="launchId" value={s.launchId} />
                        <input type="hidden" name="batchId" value={batchId} />
                        <SubmitButton
                          variant="warning"
                          pendingLabel="Revoking…"
                          title="Revokes the launch URL. Already-redeemed students keep their session."
                        >
                          Revoke URL
                        </SubmitButton>
                      </form>
                      <form action={regenerateLaunchAction}>
                        <input type="hidden" name="launchId" value={s.launchId} />
                        <input type="hidden" name="batchId" value={batchId} />
                        <SubmitButton
                          variant="plain"
                          pendingLabel="Regenerating…"
                          title="Re-sign with new exp + jti. The old URL stops working. New URL shown once."
                        >
                          Regenerate
                        </SubmitButton>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
