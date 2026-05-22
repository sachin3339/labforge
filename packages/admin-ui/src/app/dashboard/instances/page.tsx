import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';

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
  template: { id: string; name: string };
  launch: { id: string; userDisplayName: string | null } | null;
};

type GradeOutcome = {
  id: string;
  score: number;
  maxScore: number;
  passed: boolean;
};

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

async function grade(formData: FormData) {
  'use server';
  const instanceId = String(formData.get('instanceId') ?? '');
  if (!instanceId) return;
  const res = await apiFetch<GradeOutcome | { error: string; message?: string }>(
    `/api/v1/grading/instances/${instanceId}`,
    { method: 'POST' },
  );
  revalidatePath('/dashboard/instances');
  if (!res.ok) {
    redirect(`/dashboard/instances?gradeErr=${encodeURIComponent(res.error)}`);
  }
  const data = res.data;
  if ('error' in data) {
    redirect(
      `/dashboard/instances?gradeErr=${encodeURIComponent(data.error)}&msg=${encodeURIComponent(data.message ?? '')}`,
    );
  }
  redirect(
    `/dashboard/instances?graded=${encodeURIComponent(instanceId)}&score=${data.score}&max=${data.maxScore}&passed=${data.passed ? '1' : '0'}`,
  );
}

export default async function InstancesPage({
  searchParams,
}: {
  searchParams: Promise<{
    graded?: string;
    score?: string;
    max?: string;
    passed?: string;
    gradeErr?: string;
    msg?: string;
  }>;
}) {
  const sp = await searchParams;
  const res = await apiFetch<{ instances: Instance[] }>('/api/v1/admin/instances');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const items = res.data.instances;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Live labs</h1>
        <p className="text-sm text-ink-900/60">
          Recently provisioned lab instances and their current state.
        </p>
      </header>

      {sp.graded && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            sp.passed === '1'
              ? 'bg-green-50 text-green-800'
              : 'bg-amber-50 text-amber-800'
          }`}
        >
          Graded instance{' '}
          <span className="font-mono text-xs">{sp.graded.slice(0, 12)}</span>:
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
          No instances yet. Trigger a launch to see one appear.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
              <tr>
                <th className="px-4 py-3">Subdomain</th>
                <th className="px-4 py-3">Template</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t border-ink-100">
                  <td className="px-4 py-3 font-mono text-xs">{i.subdomain}</td>
                  <td className="px-4 py-3">{i.template.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`badge ${STATUS_TONE[i.status] ?? 'bg-ink-100'}`}
                    >
                      {i.status}
                    </span>
                    {i.isPrewarm && (
                      <span className="badge ml-1 bg-indigo-100 text-indigo-800">
                        prewarm
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {i.launch?.userDisplayName ??
                      (i.userIdHash ? i.userIdHash.slice(0, 10) + '…' : '—')}
                  </td>
                  <td className="px-4 py-3 text-xs">{formatTime(i.createdAt)}</td>
                  <td className="px-4 py-3 text-xs">{formatTime(i.expiresAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {(i.status === 'ready' || i.status === 'idle') && (
                      <form action={grade}>
                        <input type="hidden" name="instanceId" value={i.id} />
                        <button
                          className="btn-secondary text-xs"
                          type="submit"
                          title="Run grader against this instance"
                        >
                          Grade
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString();
}
