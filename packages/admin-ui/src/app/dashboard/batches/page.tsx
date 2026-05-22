import Link from 'next/link';
import { apiFetch } from '@/lib/api';

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

export default async function BatchesPage() {
  const res = await apiFetch<{ batches: BatchSummary[] }>('/api/v1/batches');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const batches = res.data.batches;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Batches</h1>
          <p className="text-sm text-ink-900/60">
            Pre-issued bulk launch URLs handed off to clients (e.g. 50 seats
            for one cohort). Each URL is single-use; redeemed URLs become
            live lab sessions.
          </p>
        </div>
        <Link href="/dashboard/batches/new" className="btn-primary">
          New batch
        </Link>
      </header>

      {batches.length === 0 ? (
        <div className="card text-center text-sm text-ink-900/60">
          No batches yet. Click <strong>New batch</strong> to issue seats.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
              <tr>
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Template</th>
                <th className="px-4 py-3">Seats</th>
                <th className="px-4 py-3">Redeemed</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.batchId} className="border-t border-ink-100">
                  <td className="px-4 py-3">
                    <div className="font-medium">{b.label}</div>
                    <div className="font-mono text-xs text-ink-900/50">
                      {b.batchId}
                    </div>
                  </td>
                  <td className="px-4 py-3">{b.templateName}</td>
                  <td className="px-4 py-3">{b.count}</td>
                  <td className="px-4 py-3">
                    {b.redeemed}/{b.count}
                  </td>
                  <td className="px-4 py-3">{b.active}</td>
                  <td className="px-4 py-3 text-xs">
                    {new Date(b.expiresAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/dashboard/batches/${b.batchId}`}
                      className="btn-secondary text-xs"
                    >
                      View URLs
                    </Link>
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
