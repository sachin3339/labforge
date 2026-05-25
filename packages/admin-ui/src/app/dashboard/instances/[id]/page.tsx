import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { SubmitButton } from '@/components/submit-button';
import {
  suspendAction,
  resumeAction,
  restartAction,
  terminateAction,
  extendAction,
  gradeAction,
  openLaunchAction,
} from '../actions';

type Instance = {
  id: string;
  subdomain: string;
  status: string;
  runtimeId: string | null;
  upstream: string | null;
  isPrewarm: boolean;
  volumeName: string | null;
  userIdHash: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  lastActivityAt: string | null;
  suspendedAt: string | null;
  url: string | null;
  template: { id: string; name: string; description: string | null };
  launch: {
    id: string;
    userDisplayName: string | null;
    redeemedAt: string | null;
    expiresAt: string;
  } | null;
};

const STATUS_DOT: Record<string, string> = {
  ready: 'dot-emerald',
  idle: 'dot-amber',
  pending: 'dot-sky',
  provisioning: 'dot-sky',
  paused: 'dot-purple',
  terminating: 'dot-ink',
  terminated: 'dot-ink',
  failed: 'dot-red',
};

export default async function InstanceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tail?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tail = Math.max(1, Math.min(5000, Number(sp.tail ?? '500') || 500));

  const [detailRes, logsRes] = await Promise.all([
    apiFetch<{ instance: Instance }>(`/api/v1/admin/instances/${id}`),
    apiFetch<{ logs: string; tail: number }>(`/api/v1/admin/instances/${id}/logs?tail=${tail}`),
  ]);

  if (!detailRes.ok) {
    if (detailRes.status === 404) notFound();
    return <div className="text-red-600">Error: {detailRes.error}</div>;
  }
  const i = detailRes.data.instance;
  const logs = logsRes.ok ? logsRes.data.logs : `(failed to load logs: ${logsRes.ok ? '' : logsRes.error})`;

  const canSuspend = ['ready', 'idle'].includes(i.status);
  const canResume = i.status === 'paused';
  const canRestart = ['ready', 'idle', 'paused'].includes(i.status);
  const canTerminate = !['terminated', 'failed'].includes(i.status);
  const canGrade = ['ready', 'idle'].includes(i.status);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link
              href="/dashboard/instances"
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              ← All instances
            </Link>
            <h1 className="mt-1 font-mono text-xl text-ink-900">{i.subdomain}</h1>
            <p className="mt-1 text-sm text-ink-600">
              {i.template.name}
              {i.template.description ? ` — ${i.template.description}` : ''}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="badge badge-muted">
                <span className={`dot ${STATUS_DOT[i.status] ?? 'dot-ink'}`} />
                {i.status}
              </span>
              {i.isPrewarm && (
                <span className="badge bg-indigo-100 text-indigo-800">prewarm</span>
              )}
              {i.launch && !['terminated', 'failed'].includes(i.status) && (
                <form action={openLaunchAction}>
                  <input type="hidden" name="launchId" value={i.launch.id} />
                  <SubmitButton
                    variant="primary"
                    pendingLabel="Opening lab…"
                    title="Open the lab (admin preview). Sets an admin session cookie."
                  >
                    Open lab ↗
                  </SubmitButton>
                </form>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {canSuspend && <ActionBtn action={suspendAction} id={i.id} label="Suspend" tone="warning" />}
            {canResume && <ActionBtn action={resumeAction} id={i.id} label="Resume" tone="primary" />}
            {canRestart && <ActionBtn action={restartAction} id={i.id} label="Restart" tone="secondary" />}
            {canGrade && <ActionBtn action={gradeAction} id={i.id} label="Grade" tone="secondary" />}
          </div>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h2 className="text-sm font-semibold">Identifiers</h2>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-900/60">ID</dt>
            <dd className="font-mono">{i.id}</dd>
            <dt className="text-ink-900/60">Runtime</dt>
            <dd className="font-mono break-all">{i.runtimeId ?? '—'}</dd>
            <dt className="text-ink-900/60">Upstream</dt>
            <dd className="font-mono">{i.upstream ?? '—'}</dd>
            <dt className="text-ink-900/60">Volume</dt>
            <dd className="font-mono break-all">{i.volumeName ?? '—'}</dd>
            <dt className="text-ink-900/60">User hash</dt>
            <dd className="font-mono">{i.userIdHash?.slice(0, 24) ?? '—'}…</dd>
            <dt className="text-ink-900/60">Launch</dt>
            <dd>
              {i.launch ? (
                <Link href={`/dashboard/batches`} className="text-brand hover:underline font-mono">
                  {i.launch.userDisplayName ?? i.launch.id.slice(0, 12)}
                </Link>
              ) : (
                '—'
              )}
            </dd>
          </dl>
        </div>

        <div className="card">
          <h2 className="text-sm font-semibold">Timestamps</h2>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-900/60">Created</dt>
            <dd>{formatTime(i.createdAt)}</dd>
            <dt className="text-ink-900/60">Last seen</dt>
            <dd>{i.lastSeenAt ? formatTime(i.lastSeenAt) : '—'}</dd>
            <dt className="text-ink-900/60">Last activity</dt>
            <dd>{i.lastActivityAt ? formatTime(i.lastActivityAt) : '—'}</dd>
            <dt className="text-ink-900/60">Suspended</dt>
            <dd>{i.suspendedAt ? formatTime(i.suspendedAt) : '—'}</dd>
            <dt className="text-ink-900/60">Expires</dt>
            <dd>
              {formatTime(i.expiresAt)}{' '}
              <span className="text-ink-900/50">({remainingFromNow(i.expiresAt)})</span>
            </dd>
          </dl>

          <form action={extendAction} className="mt-3 flex items-center gap-2 text-xs">
            <input type="hidden" name="instanceId" value={i.id} />
            <label className="text-ink-900/70">Extend by</label>
            <input
              type="number"
              name="extendHours"
              defaultValue={24}
              min={1}
              max={8760}
              className="w-20 rounded border border-ink-200 px-2 py-1"
            />
            <span className="text-ink-900/70">hours</span>
            <SubmitButton variant="plain" pendingLabel="Extending…">
              Extend
            </SubmitButton>
          </form>
        </div>
      </section>

      {/* Danger zone */}
      {canTerminate && (
        <section className="card border-red-200">
          <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
          <p className="mt-1 text-xs text-ink-900/60">
            Terminating stops the container and removes it. The persistent volume
            is preserved unless you check the box below — useful for releasing
            disk on a tenant who has dropped the course.
          </p>
          <form action={terminateAction} className="mt-3 flex items-center gap-3 text-xs">
            <input type="hidden" name="instanceId" value={i.id} />
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="deleteVolume" value="1" />
              Also delete the volume (irreversible)
            </label>
            <SubmitButton variant="danger" pendingLabel="Terminating…">
              Terminate instance
            </SubmitButton>
          </form>
        </section>
      )}

      {/* Logs */}
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Container logs</h2>
          <form className="flex items-center gap-2 text-xs">
            <label className="text-ink-900/70">Tail</label>
            <select
              name="tail"
              defaultValue={String(tail)}
              className="rounded border border-ink-200 px-2 py-1"
            >
              <option value="100">100</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
              <option value="5000">5000</option>
            </select>
            <button
              type="submit"
              className="rounded border border-ink-200 bg-white px-2 py-1 hover:bg-ink-50"
            >
              Refresh
            </button>
          </form>
        </div>
        <pre className="mt-3 max-h-[480px] overflow-auto rounded bg-ink-900 p-3 font-mono text-[11px] leading-relaxed text-ink-100 whitespace-pre-wrap">
          {logs || '(no log output)'}
        </pre>
      </section>
    </div>
  );
}

function ActionBtn({
  action,
  id,
  label,
  tone,
}: {
  action: (formData: FormData) => Promise<void>;
  id: string;
  label: string;
  tone: 'primary' | 'secondary' | 'warning';
}) {
  const variant =
    tone === 'primary' ? 'primary' : tone === 'warning' ? 'warning' : 'plain';
  return (
    <form action={action}>
      <input type="hidden" name="instanceId" value={id} />
      <SubmitButton variant={variant} pendingLabel={`${label}…`}>
        {label}
      </SubmitButton>
    </form>
  );
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString();
}

function remainingFromNow(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 48) return `${Math.floor(h / 24)}d`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
