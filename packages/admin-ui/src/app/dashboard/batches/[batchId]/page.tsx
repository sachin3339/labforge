import Link from 'next/link';
import { apiFetch } from '@/lib/api';

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
    instance: {
      id: string;
      subdomain: string;
      status: string;
      lastSeenAt: string | null;
    } | null;
  }[];
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
  'not-redeemed': 'bg-ink-50 text-ink-900/60',
};

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const res = await apiFetch<BatchDetail>(`/api/v1/batches/${batchId}`);
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const b = res.data;
  const redeemed = b.seats.filter((s) => s.redeemed).length;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{b.label}</h1>
            <p className="text-sm text-ink-900/60">
              Template <strong>{b.templateName}</strong> · {b.seats.length}{' '}
              seats · {redeemed} redeemed · expires{' '}
              {new Date(b.expiresAt).toLocaleString()}
            </p>
          </div>
          <Link href="/dashboard/batches" className="btn-secondary text-sm">
            ← All batches
          </Link>
        </div>
      </header>

      <div className="rounded-md bg-ink-50 px-4 py-3 text-sm text-ink-900/70">
        Per-seat status. The actual launch URLs are not shown here for
        security — they were displayed only at batch creation. If you lost
        them, create a new batch.
      </div>

      <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
            <tr>
              <th className="px-3 py-2 w-12">#</th>
              <th className="px-3 py-2">Seat</th>
              <th className="px-3 py-2">Redeemed</th>
              <th className="px-3 py-2">Lab status</th>
              <th className="px-3 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {b.seats.map((s) => {
              const status = s.instance?.status ?? 'not-redeemed';
              return (
                <tr key={s.launchId} className="border-t border-ink-100">
                  <td className="px-3 py-2 text-xs text-ink-900/60">{s.seat}</td>
                  <td className="px-3 py-2">{s.displayName}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.redeemed ? new Date(s.redeemed).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[status] ?? 'bg-ink-50'}`}
                    >
                      {status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-900/60">
                    {s.instance?.lastSeenAt
                      ? new Date(s.instance.lastSeenAt).toLocaleString()
                      : '—'}
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
