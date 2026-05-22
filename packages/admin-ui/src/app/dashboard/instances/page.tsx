import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import {
  suspendAction,
  resumeAction,
  restartAction,
  terminateAction,
  gradeAction,
} from './actions';

type Instance = {
  id: string;
  subdomain: string;
  status: string;
  runtimeId: string | null;
  upstream: string | null;
  isPrewarm: boolean;
  userIdHash: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  lastActivityAt: string | null;
  suspendedAt: string | null;
  template: { id: string; name: string };
  launch: { id: string; userDisplayName: string | null } | null;
};

type Template = { id: string; name: string };

const STATUS_TONE: Record<string, string> = {
  ready: 'bg-green-100 text-green-800',
  idle: 'bg-amber-100 text-amber-800',
  pending: 'bg-blue-100 text-blue-800',
  provisioning: 'bg-blue-100 text-blue-800',
  paused: 'bg-purple-100 text-purple-800',
  terminating: 'bg-ink-100 text-ink-900/70',
  terminated: 'bg-ink-100 text-ink-900/50',
  failed: 'bg-red-100 text-red-800',
};

const STATUS_OPTIONS = [
  'pending',
  'provisioning',
  'ready',
  'idle',
  'paused',
  'terminating',
  'terminated',
  'failed',
];

export default async function InstancesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    templateId?: string;
    includeTerminated?: string;
    graded?: string;
    score?: string;
    max?: string;
    passed?: string;
    gradeErr?: string;
    msg?: string;
  }>;
}) {
  const sp = await searchParams;

  const qs = new URLSearchParams();
  qs.set('limit', '200');
  if (sp.status) qs.set('status', sp.status);
  if (sp.templateId) qs.set('templateId', sp.templateId);
  if (sp.includeTerminated === '1') qs.set('includeTerminated', '1');

  const [instancesRes, templatesRes] = await Promise.all([
    apiFetch<{ instances: Instance[] }>(`/api/v1/admin/instances?${qs.toString()}`),
    apiFetch<{ templates: Template[] }>('/api/v1/templates'),
  ]);
  if (!instancesRes.ok) return <div className="text-red-600">Error: {instancesRes.error}</div>;
  const items = instancesRes.data.instances;
  const templates = templatesRes.ok ? templatesRes.data.templates : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Live labs</h1>
        <p className="text-sm text-ink-900/60">
          Every lab instance for this tenant. Filter, inspect, and act on them
          without leaving the page.
        </p>
      </header>

      {/* Filters */}
      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-ink-100 bg-white p-4">
        <label className="flex flex-col text-xs text-ink-900/70">
          Status
          <select
            name="status"
            defaultValue={sp.status ?? ''}
            className="mt-1 rounded border border-ink-200 px-2 py-1 text-sm"
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-ink-900/70">
          Template
          <select
            name="templateId"
            defaultValue={sp.templateId ?? ''}
            className="mt-1 rounded border border-ink-200 px-2 py-1 text-sm"
          >
            <option value="">All</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-900/70">
          <input
            type="checkbox"
            name="includeTerminated"
            value="1"
            defaultChecked={sp.includeTerminated === '1'}
          />
          Include terminated
        </label>
        <button className="btn-primary text-xs" type="submit">
          Apply
        </button>
        <Link href="/dashboard/instances" className="btn-secondary text-xs">
          Reset
        </Link>
        <span className="ml-auto text-xs text-ink-900/50">
          {items.length} result{items.length === 1 ? '' : 's'}
        </span>
      </form>

      {/* Banners */}
      {sp.graded && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            sp.passed === '1' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
          }`}
        >
          Graded instance <span className="font-mono text-xs">{sp.graded.slice(0, 12)}</span>:{' '}
          score <strong>{sp.score}</strong> / {sp.max} —{' '}
          {sp.passed === '1' ? 'PASSED' : 'FAILED'}
        </div>
      )}
      {sp.gradeErr && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Grading failed: {sp.gradeErr}
          {sp.msg && ` — ${sp.msg}`}
        </div>
      )}

      {items.length === 0 ? (
        <div className="card text-center text-sm text-ink-900/60">
          No instances match the current filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
              <tr>
                <th className="px-3 py-3">Subdomain</th>
                <th className="px-3 py-3">Template</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">User</th>
                <th className="px-3 py-3">Created</th>
                <th className="px-3 py-3">Last activity</th>
                <th className="px-3 py-3">Expires</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const canSuspend = ['ready', 'idle'].includes(i.status);
                const canResume = i.status === 'paused';
                const canRestart = ['ready', 'idle', 'paused'].includes(i.status);
                const canTerminate = !['terminated', 'failed'].includes(i.status);
                const canGrade = ['ready', 'idle'].includes(i.status);

                return (
                  <tr key={i.id} className="border-t border-ink-100 align-top">
                    <td className="px-3 py-3 font-mono text-xs">
                      <Link
                        href={`/dashboard/instances/${i.id}`}
                        className="text-brand hover:underline"
                      >
                        {i.subdomain}
                      </Link>
                    </td>
                    <td className="px-3 py-3">{i.template.name}</td>
                    <td className="px-3 py-3">
                      <span className={`badge ${STATUS_TONE[i.status] ?? 'bg-ink-100'}`}>
                        {i.status}
                      </span>
                      {i.isPrewarm && (
                        <span className="badge ml-1 bg-indigo-100 text-indigo-800">prewarm</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {i.launch?.userDisplayName ??
                        (i.userIdHash ? i.userIdHash.slice(0, 10) + '…' : '—')}
                    </td>
                    <td className="px-3 py-3 text-xs">{formatTime(i.createdAt)}</td>
                    <td className="px-3 py-3 text-xs">
                      {i.lastActivityAt ? formatTime(i.lastActivityAt) : '—'}
                    </td>
                    <td className="px-3 py-3 text-xs">{formatTime(i.expiresAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {canSuspend && (
                          <RowButton
                            action={suspendAction}
                            id={i.id}
                            label="Suspend"
                            tone="warning"
                          />
                        )}
                        {canResume && (
                          <RowButton
                            action={resumeAction}
                            id={i.id}
                            label="Resume"
                            tone="primary"
                          />
                        )}
                        {canRestart && (
                          <RowButton
                            action={restartAction}
                            id={i.id}
                            label="Restart"
                            tone="secondary"
                          />
                        )}
                        {canGrade && (
                          <RowButton
                            action={gradeAction}
                            id={i.id}
                            label="Grade"
                            tone="secondary"
                          />
                        )}
                        {canTerminate && (
                          <form action={terminateAction}>
                            <input type="hidden" name="instanceId" value={i.id} />
                            <button
                              type="submit"
                              className="rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                              title="Stop and remove the container. Volume preserved."
                            >
                              Terminate
                            </button>
                          </form>
                        )}
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

function RowButton({
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
  const cls =
    tone === 'primary'
      ? 'bg-brand text-white hover:bg-brand/90 border-brand'
      : tone === 'warning'
        ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
        : 'bg-white text-ink-900/80 border-ink-200 hover:bg-ink-50';
  return (
    <form action={action}>
      <input type="hidden" name="instanceId" value={id} />
      <button type="submit" className={`rounded border px-2 py-1 text-xs ${cls}`}>
        {label}
      </button>
    </form>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString();
}
