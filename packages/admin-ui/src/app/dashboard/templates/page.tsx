import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { IconTemplate, IconPencil, IconTrash, IconExternal } from '@/components/icons';

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

  // Rough roll-up: how many templates carry prewarm capacity and what the
  // total list-price exposure looks like. Read-only — no API change.
  const prewarmTotal = templates.reduce((a, t) => a + (t.spec.prewarm ?? 0), 0);
  const priced = templates.filter((t) => t.spec.priceListUsd !== undefined).length;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow">Catalog</div>
            <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <IconTemplate size={22} className="text-brand-600" />
              Templates
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-600">
              Each template is one kind of lab environment students can launch.
            </p>
          </div>
          <Link href="/dashboard/templates/new" className="btn-primary">
            New template
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="kpi text-brand-500">
          <div className="kpi-label">Templates</div>
          <div className="kpi-value">{templates.length}</div>
        </div>
        <div className="kpi text-emerald-500">
          <div className="kpi-label">Prewarm capacity</div>
          <div className="kpi-value">{prewarmTotal}</div>
          <div className="kpi-hint">Containers kept hot across catalog</div>
        </div>
        <div className="kpi text-sky-500">
          <div className="kpi-label">Priced</div>
          <div className="kpi-value">{priced}</div>
          <div className="kpi-hint">Have a list-price configured</div>
        </div>
      </div>

      {templates.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">
            <IconTemplate size={20} />
          </div>
          <div className="text-sm font-medium text-ink-800">No templates yet</div>
          <div className="text-xs text-ink-500">
            Click <strong>New template</strong> to create your first lab
            environment.
          </div>
        </div>
      ) : (
        <div className="table-wrap scroll-pretty overflow-x-auto">
          <table className="table-clean">
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>Resources</th>
                <th>Prewarm</th>
                <th>Pricing</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="font-medium text-ink-900">{t.name}</div>
                    {t.description && (
                      <div className="text-xs text-ink-500">{t.description}</div>
                    )}
                  </td>
                  <td className="font-mono text-xs text-ink-700">{t.spec.image}</td>
                  <td className="text-xs text-ink-700">
                    <span className="badge badge-muted">
                      {t.spec.cpu} vCPU
                    </span>
                    <span className="badge badge-muted ml-1">
                      {t.spec.memoryMb} MB
                    </span>
                  </td>
                  <td className="text-xs">
                    {t.spec.prewarm ? (
                      <span className="badge bg-emerald-50 text-emerald-700">
                        <span className="dot bg-emerald-500" />
                        {t.spec.prewarm} warm
                      </span>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {t.spec.costPerHourUsd !== undefined || t.spec.priceListUsd !== undefined ? (
                      <div className="space-y-0.5">
                        <div className="text-ink-500">
                          cost ${t.spec.costPerHourUsd?.toFixed(3) ?? '—'}/h
                        </div>
                        <div className="font-medium text-ink-900">
                          list ${t.spec.priceListUsd?.toFixed(2) ?? '—'}
                        </div>
                      </div>
                    ) : (
                      <span className="text-ink-400">—</span>
                    )}
                  </td>
                  <td className="text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <Link
                        href={`/dashboard/templates/${t.id}/edit`}
                        className="btn-secondary text-xs"
                      >
                        <IconPencil size={12} />
                        Edit
                      </Link>
                      <form action={launchTest.bind(null, t.id)} className="inline">
                        <button className="btn-primary text-xs" type="submit">
                          <IconExternal size={12} />
                          Launch test
                        </button>
                      </form>
                      <form action={deleteTemplate.bind(null, t.id)} className="inline">
                        <button
                          className="btn-ghost text-xs text-red-700 hover:bg-red-50"
                          type="submit"
                          title="Delete template"
                        >
                          <IconTrash size={12} />
                          Delete
                        </button>
                      </form>
                    </div>
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
