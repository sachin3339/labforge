import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { LabFrame } from './LabFrame';

/**
 * Full-bleed lab viewer. The "Open lab" button on instances / batches now
 * lands here instead of redirecting straight to the lab subdomain. We mint
 * a fresh preview URL server-side on every render (the token is one-use,
 * so refreshing the page transparently re-issues), and hand it to a client
 * island that owns the iframe + fullscreen toggle.
 */
export default async function LabViewerPage({
  params,
}: {
  params: Promise<{ launchId: string }>;
}) {
  const { launchId } = await params;

  const res = await apiFetch<{
    url: string;
    templateName?: string | null;
    node?: { id: string; name: string } | null;
  }>(`/api/v1/launches/${launchId}/preview-url`, { method: 'POST' });

  if (!res.ok) {
    return (
      <div className="card mx-auto mt-12 max-w-lg text-sm">
        <h1 className="text-base font-semibold">Could not open lab</h1>
        <p className="mt-2 text-ink-900/70">{res.error}</p>
        <Link
          href="/dashboard/instances"
          className="btn-secondary mt-4 inline-block"
        >
          Back to instances
        </Link>
      </div>
    );
  }

  return (
    <LabFrame
      src={res.data.url}
      launchId={launchId}
      nodeName={res.data.node?.name ?? null}
      templateName={res.data.templateName ?? null}
    />
  );
}

// Render full-bleed without the dashboard chrome — the lab needs the
// whole viewport for KasmVNC.
export const dynamic = 'force-dynamic';
