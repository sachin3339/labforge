import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';

type Template = {
  id: string;
  name: string;
  description: string | null;
  spec: {
    image: string;
    runtime: string;
    port: number;
    cpu: number;
    memoryMb: number;
    prewarm?: number;
    costPerHourUsd?: number;
    priceListUsd?: number;
  };
  createdAt: string;
};

async function deleteTemplate(id: string) {
  'use server';
  await apiFetch(`/api/v1/templates/${id}`, { method: 'DELETE' });
  revalidatePath('/dashboard/templates');
}

async function launchTest(templateId: string) {
  'use server';
  const res = await apiFetch<{ launchUrl: string }>('/api/v1/launches', {
    method: 'POST',
    body: JSON.stringify({
      templateId,
      userId: `admin-test-${Date.now()}`,
      userDisplayName: 'Admin (test)',
      durationMinutes: 60,
    }),
  });
  if (!res.ok) {
    redirect(`/dashboard/templates?error=${encodeURIComponent(res.error)}`);
  }
  // Browser follows this redirect to the single-use launch URL.
  redirect(res.data.launchUrl);
}

export default async function TemplatesPage() {
  const res = await apiFetch<{ templates: Template[] }>('/api/v1/templates');
  if (!res.ok) return <div className="text-red-600">Error: {res.error}</div>;
  const templates = res.data.templates;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Templates</h1>
          <p className="text-sm text-ink-900/60">
            Each template is one kind of lab environment students can launch.
          </p>
        </div>
        <Link href="/dashboard/templates/new" className="btn-primary">
          New template
        </Link>
      </header>

      {templates.length === 0 ? (
        <div className="card text-center text-sm text-ink-900/60">
          No templates yet. Create your first one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Image</th>
                <th className="px-4 py-3">Resources</th>
                <th className="px-4 py-3">Prewarm</th>
                <th className="px-4 py-3">Pricing</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t border-ink-100">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.name}</div>
                    {t.description && (
                      <div className="text-xs text-ink-900/60">{t.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{t.spec.image}</td>
                  <td className="px-4 py-3 text-xs">
                    {t.spec.cpu} vCPU · {t.spec.memoryMb} MB
                  </td>
                  <td className="px-4 py-3 text-xs">{t.spec.prewarm ?? 0}</td>
                  <td className="px-4 py-3 text-xs">
                    {t.spec.costPerHourUsd !== undefined || t.spec.priceListUsd !== undefined ? (
                      <div className="space-y-0.5">
                        <div className="text-ink-900/60">
                          cost: ${t.spec.costPerHourUsd?.toFixed(3) ?? '—'}/h
                        </div>
                        <div className="font-medium">
                          list: ${t.spec.priceListUsd?.toFixed(2) ?? '—'}
                        </div>
                      </div>
                    ) : (
                      <span className="text-ink-900/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/dashboard/templates/${t.id}/edit`}
                      className="btn-secondary text-xs"
                    >
                      Edit
                    </Link>
                    <form
                      action={launchTest.bind(null, t.id)}
                      className="ml-2 inline"
                    >
                      <button className="btn-primary text-xs" type="submit">
                        Launch test lab
                      </button>
                    </form>
                    <form
                      action={deleteTemplate.bind(null, t.id)}
                      className="ml-2 inline"
                    >
                      <button
                        className="btn-secondary text-xs"
                        type="submit"
                      >
                        Delete
                      </button>
                    </form>
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
