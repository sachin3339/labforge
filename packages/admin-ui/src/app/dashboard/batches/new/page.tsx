import { apiFetch } from '@/lib/api';
import { NewBatchClient } from './NewBatchClient';

type Template = { id: string; name: string; description: string | null };

export default async function NewBatchPage() {
  const res = await apiFetch<{ templates: Template[] }>('/api/v1/templates');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New batch</h1>
        <p className="text-sm text-ink-900/60">
          Issue N pre-signed launch URLs for one client / cohort. Each URL is
          single-use and works in any browser — paste them into your client&apos;s
          LMS, email them out, or embed in an iframe.
        </p>
      </header>
      <NewBatchClient templates={res.data.templates} />
    </div>
  );
}
