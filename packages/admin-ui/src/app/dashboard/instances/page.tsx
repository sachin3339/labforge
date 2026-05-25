import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { SubmitButton } from '@/components/submit-button';
import {
  IconServer,
  IconActivity,
  IconClock,
  IconUser,
  IconFilter,
  IconRefresh,
} from '@/components/icons';
import {
  suspendAction,
  resumeAction,
  restartAction,
  terminateAction,
  gradeAction,
  openLaunchAction,
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
  node: { id: string; name: string } | null;
  launch: { id: string; userDisplayName: string | null } | null;
};

type Template = { id: string; name: string };

// Map every status to a (label, dot-class) so the table reads consistently
// — colored dot + lowercase label, same pattern as Linear / Vercel.
const STATUS_META: Record<string, { dot: string; label: string }> = {
  ready: { dot: 'dot-emerald', label: 'ready' },
  idle: { dot: 'dot-amber', label: 'idle' },
  pending: { dot: 'dot-sky', label: 'pending' },
  provisioning: { dot: 'dot-sky', label: 'provisioning' },
  paused: { dot: 'dot-purple', label: 'paused' },
  terminating: { dot: 'dot-ink', label: 'terminating' },
  terminated: { dot: 'dot-ink', label: 'terminated' },
  failed: { dot: 'dot-red', label: 'failed' },
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

  // Activity rollup: bucket live (non-terminated) labs by lastActivityAt.
  // Drives the summary cards at the top so admins can see at a glance how
  // many of the running labs are actually being used right now.
  const ACTIVE_MIN = 5;
  const IDLE_MIN = 30;
  const now = Date.now();
  const liveItems = items.filter(
    (i) => !['terminated', 'failed', 'terminating'].includes(i.status),
  );
  const activity = liveItems.reduce(
    (acc, i) => {
      const last = i.lastActivityAt ? new Date(i.lastActivityAt).getTime() : null;
      if (last == null) acc.neverUsed += 1;
      else {
        const idleMin = (now - last) / 60_000;
        if (idleMin < ACTIVE_MIN) acc.active += 1;
        else if (idleMin < IDLE_MIN) acc.recentlyIdle += 1;
        else acc.idleLong += 1;
      }
      if (i.status === 'paused') acc.paused += 1;
      return acc;
    },
    { active: 0, recentlyIdle: 0, idleLong: 0, neverUsed: 0, paused: 0 },
  );

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow">Operations</div>
            <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <IconServer size={22} className="text-brand-600" />
              Live labs
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-600">
              Every lab instance for this tenant. Filter, inspect, and act on
              them without leaving the page.
            </p>
          </div>
          <Link
            href="/dashboard/instances"
            className="btn-secondary text-xs"
            title="Refresh"
          >
            <IconRefresh size={14} />
            Refresh
          </Link>
        </div>
      </header>

      {/* Activity rollup — see kpi component class in globals.css. The
          colored ::after bar uses currentColor of the wrapper, set via the
          tone class on each tile. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Total live" value={liveItems.length} tone="text-ink-500" />
        <StatTile
          label={`Active · ≤${ACTIVE_MIN}m`}
          value={activity.active}
          tone="text-emerald-500"
          live
        />
        <StatTile
          label={`Recently idle · <${IDLE_MIN}m`}
          value={activity.recentlyIdle}
          tone="text-amber-500"
        />
        <StatTile
          label={`Idle long · ≥${IDLE_MIN}m`}
          value={activity.idleLong}
          tone="text-red-500"
        />
        <StatTile
          label="Never used"
          value={activity.neverUsed}
          tone="text-ink-400"
        />
      </div>

      {/* Filters */}
      <form className="toolbar">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
          <IconFilter size={14} />
          Filter
        </div>
        <label>
          Status
          <select name="status" defaultValue={sp.status ?? ''}>
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Template
          <select name="templateId" defaultValue={sp.templateId ?? ''}>
            <option value="">All</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-row items-center gap-2 normal-case tracking-normal !text-xs !text-ink-700">
          <input
            type="checkbox"
            name="includeTerminated"
            value="1"
            defaultChecked={sp.includeTerminated === '1'}
            className="h-3.5 w-3.5 rounded border-ink-300 text-brand-600 focus:ring-brand-500/30"
          />
          Include terminated
        </label>
        <div className="flex items-center gap-2">
          <button className="btn-primary text-xs" type="submit">
            Apply
          </button>
          <Link href="/dashboard/instances" className="btn-ghost text-xs">
            Reset
          </Link>
        </div>
        <span className="ml-auto text-xs text-ink-500">
          {items.length} result{items.length === 1 ? '' : 's'}
        </span>
      </form>

      {/* Banners */}
      {sp.graded && (
        <div className={sp.passed === '1' ? 'banner-success' : 'banner-warn'}>
          Graded instance{' '}
          <span className="font-mono text-xs">{sp.graded.slice(0, 12)}</span>:
          score <strong>{sp.score}</strong> / {sp.max} —{' '}
          {sp.passed === '1' ? 'PASSED' : 'FAILED'}
        </div>
      )}
      {sp.gradeErr && (
        <div className="banner-error">
          Grading failed: {sp.gradeErr}
          {sp.msg && ` — ${sp.msg}`}
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">
            <IconServer size={20} />
          </div>
          <div className="text-sm font-medium text-ink-800">
            No instances match the current filters
          </div>
          <div className="text-xs text-ink-500">
            Try clearing the status / template filters or include terminated.
          </div>
        </div>
      ) : (
        <div className="table-wrap scroll-pretty overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Subdomain</th>
                <th>Template</th>
                <th>Node</th>
                <th>Status</th>
                <th>
                  <span className="inline-flex items-center gap-1">
                    <IconUser size={12} />
                    User
                  </span>
                </th>
                <th>
                  <span className="inline-flex items-center gap-1">
                    <IconClock size={12} />
                    Created
                  </span>
                </th>
                <th>
                  <span className="inline-flex items-center gap-1">
                    <IconActivity size={12} />
                    Last activity
                  </span>
                </th>
                <th>Expires</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const canSuspend = ['ready', 'idle'].includes(i.status);
                const canResume = i.status === 'paused';
                const canRestart = ['ready', 'idle', 'paused'].includes(i.status);
                const canTerminate = !['terminated', 'failed'].includes(i.status);
                const canGrade = ['ready', 'idle'].includes(i.status);
                const meta = STATUS_META[i.status] ?? {
                  dot: 'dot-ink',
                  label: i.status,
                };
                const lastActIso = i.lastActivityAt;
                const lastActMin = lastActIso
                  ? (now - new Date(lastActIso).getTime()) / 60_000
                  : null;
                const isLive = lastActMin != null && lastActMin < ACTIVE_MIN;

                return (
                  <tr key={i.id}>
                    <td className="font-mono text-xs">
                      <Link
                        href={`/dashboard/instances/${i.id}`}
                        className="font-medium text-brand-700 hover:text-brand-800 hover:underline"
                      >
                        {i.subdomain}
                      </Link>
                    </td>
                    <td className="text-sm text-ink-800">{i.template.name}</td>
                    <td className="text-xs">
                      {i.node ? (
                        <Link
                          href="/dashboard/platform/nodes"
                          className="badge bg-sky-50 text-sky-800 hover:bg-sky-100"
                          title="Physical host running this container"
                        >
                          <span className="dot bg-sky-500" />
                          {i.node.name}
                        </Link>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td>
                      <span className="badge badge-muted">
                        <span className={`${meta.dot} ${isLive ? 'dot-pulse' : ''}`} />
                        {meta.label}
                      </span>
                      {i.isPrewarm && (
                        <span className="badge ml-1 bg-indigo-50 text-indigo-700">
                          prewarm
                        </span>
                      )}
                    </td>
                    <td className="text-xs text-ink-700">
                      {i.launch?.userDisplayName ?? (
                        i.userIdHash ? (
                          <span className="font-mono text-ink-500">
                            {i.userIdHash.slice(0, 10)}…
                          </span>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )
                      )}
                    </td>
                    <td className="text-xs text-ink-600" title={formatTime(i.createdAt)}>
                      {formatRelative(i.createdAt, now)}
                    </td>
                    <td className="text-xs" title={lastActIso ? formatTime(lastActIso) : ''}>
                      {lastActIso ? (
                        <span
                          className={
                            isLive
                              ? 'font-medium text-emerald-700'
                              : lastActMin != null && lastActMin < IDLE_MIN
                                ? 'text-amber-700'
                                : 'text-ink-500'
                          }
                        >
                          {formatRelative(lastActIso, now)}
                        </span>
                      ) : (
                        <span className="text-ink-400">never</span>
                      )}
                    </td>
                    <td className="text-xs text-ink-600" title={formatTime(i.expiresAt)}>
                      {formatRelative(i.expiresAt, now)}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {i.launch && !['terminated', 'failed'].includes(i.status) && (
                          <form action={openLaunchAction}>
                            <input type="hidden" name="launchId" value={i.launch.id} />
                            <SubmitButton
                              variant="success"
                              pendingLabel="Opening…"
                              title="Open this lab in a new tab (admin preview)."
                            >
                              Open
                            </SubmitButton>
                          </form>
                        )}
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
                            <SubmitButton
                              variant="plain"
                              pendingLabel="Terminating…"
                              className="border-red-300 text-red-700 hover:bg-red-50"
                              title="Stop and remove the container. Volume preserved."
                            >
                              Terminate
                            </SubmitButton>
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
  const d = new Date(iso);
  return d.toLocaleString();
}

// Compact relative time formatter — keeps the table dense without losing
// at-a-glance recency. The full timestamp is exposed via the cell's title.
function formatRelative(iso: string, nowMs: number) {
  const t = new Date(iso).getTime();
  const diffMs = t - nowMs;
  const past = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  let s: string;
  if (sec < 60) s = `${sec}s`;
  else if (min < 60) s = `${min}m`;
  else if (hr < 24) s = `${hr}h`;
  else s = `${day}d`;
  return past ? `${s} ago` : `in ${s}`;
}

function StatTile({
  label,
  value,
  tone,
  live = false,
}: {
  label: string;
  value: number;
  tone: string;
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
    </div>
  );
}
