import { apiFetch } from '@/lib/api';
import { NewBatchClient } from './NewBatchClient';

type Template = { id: string; name: string; description: string | null };

export default async function NewBatchPage() {
  const res = await apiFetch<{ templates: Template[] }>('/api/v1/templates');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="eyebrow">Distribution</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">New batch</h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-600">
              Issue N pre-signed launch URLs for one client / cohort. Each URL is
              single-use and works in any browser — paste them into your client&apos;s
              LMS, email them out, or embed in an iframe.
            </p>
          </div>
          <a href="/dashboard/batches" className="btn-secondary text-xs">
            Cancel
          </a>
        </div>
      </header>
      <NewBatchClient templates={res.data.templates} />
    </div>
  );
}
