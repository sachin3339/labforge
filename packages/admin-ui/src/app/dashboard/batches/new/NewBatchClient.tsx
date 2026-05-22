'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';

type Template = { id: string; name: string; description: string | null };

type BatchLaunchItem = {
  launchId: string;
  seat: number;
  displayName: string;
  launchUrl: string;
  expiresAt: string;
};

type BatchResponse = {
  batchId: string;
  label: string;
  templateId: string;
  count: number;
  createdAt: string;
  expiresAt: string;
  launches: BatchLaunchItem[];
};

export function NewBatchClient({ templates }: { templates: Template[] }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResponse | null>(null);

  const onSubmit = (formData: FormData) => {
    setError(null);
    const payload = {
      templateId: String(formData.get('templateId') ?? ''),
      label: String(formData.get('label') ?? '').trim(),
      count: Number(formData.get('count') ?? 1),
      durationMinutes: Number(formData.get('durationMinutes') ?? 120),
      ttlHours: Number(formData.get('ttlHours') ?? 24),
    };

    startTransition(async () => {
      const res = await fetch('/api/batches/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as BatchResponse | { error: string };
      if (!res.ok || 'error' in data) {
        setError('error' in data ? data.error : 'Failed');
        return;
      }
      setResult(data as BatchResponse);
    });
  };

  if (result) {
    return <BatchResult result={result} />;
  }

  if (templates.length === 0) {
    return (
      <div className="card text-sm text-ink-900/60">
        Create a{' '}
        <Link href="/dashboard/templates" className="text-brand-600 underline">
          template
        </Link>{' '}
        first.
      </div>
    );
  }

  return (
    <form action={onSubmit} className="card space-y-5">
      <div>
        <label className="text-sm font-medium" htmlFor="label">
          Batch label
        </label>
        <input
          id="label"
          name="label"
          required
          maxLength={120}
          placeholder="LTIM-DevOps-Cohort-7"
          className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-ink-900/50">
          Shown in admin only — never visible to learners.
        </p>
      </div>

      <div>
        <label className="text-sm font-medium" htmlFor="templateId">
          Template
        </label>
        <select
          id="templateId"
          name="templateId"
          required
          defaultValue=""
          className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        >
          <option value="" disabled>
            — Choose a template —
          </option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.description ? ` — ${t.description}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="text-sm font-medium" htmlFor="count">
            Seats
          </label>
          <input
            id="count"
            name="count"
            type="number"
            min={1}
            max={500}
            defaultValue={10}
            required
            className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-ink-900/50">1–500 URLs.</p>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="durationMinutes">
            Lab duration (min)
          </label>
          <input
            id="durationMinutes"
            name="durationMinutes"
            type="number"
            min={5}
            max={480}
            defaultValue={120}
            required
            className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-ink-900/50">
            Per-seat session length after redeem.
          </p>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ttlHours">
            URL valid for (hours)
          </label>
          <input
            id="ttlHours"
            name="ttlHours"
            type="number"
            min={1}
            max={168}
            defaultValue={24}
            required
            className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-ink-900/50">1–168h (7 days max).</p>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Link href="/dashboard/batches" className="btn-secondary text-sm">
          Cancel
        </Link>
        <button type="submit" disabled={isPending} className="btn-primary text-sm">
          {isPending ? 'Issuing…' : 'Issue URLs'}
        </button>
      </div>
    </form>
  );
}

function BatchResult({ result }: { result: BatchResponse }) {
  const [copied, setCopied] = useState<string | null>(null);
  const downloadCsv = () => {
    const rows = [
      ['seat', 'displayName', 'launchUrl', 'expiresAt'].join(','),
      ...result.launches.map((l) =>
        [
          l.seat,
          JSON.stringify(l.displayName),
          JSON.stringify(l.launchUrl),
          l.expiresAt,
        ].join(','),
      ),
    ];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.label.replace(/[^a-z0-9]+/gi, '_')}_${result.batchId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyAll = async () => {
    const text = result.launches.map((l) => `${l.displayName}\t${l.launchUrl}`).join('\n');
    await navigator.clipboard.writeText(text);
    setCopied('all');
    setTimeout(() => setCopied(null), 1500);
  };

  const copyOne = async (url: string, id: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-900">
        ✅ Issued <strong>{result.count}</strong> launch URLs for{' '}
        <strong>{result.label}</strong>. URLs expire{' '}
        {new Date(result.expiresAt).toLocaleString()}.
      </div>

      <div className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900">
        ⚠ Save the CSV now — these URLs are not retrievable later for
        security reasons. Once you leave this page they cannot be re-displayed.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={downloadCsv} className="btn-primary text-sm">
          Download CSV
        </button>
        <button onClick={copyAll} className="btn-secondary text-sm">
          {copied === 'all' ? 'Copied!' : 'Copy all (TSV)'}
        </button>
        <Link href="/dashboard/batches" className="btn-secondary text-sm">
          Done
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border border-ink-100 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-900/60">
            <tr>
              <th className="px-3 py-2 w-12">#</th>
              <th className="px-3 py-2">Seat</th>
              <th className="px-3 py-2">Launch URL</th>
              <th className="px-3 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {result.launches.map((l) => (
              <tr key={l.launchId} className="border-t border-ink-100">
                <td className="px-3 py-2 text-xs text-ink-900/60">{l.seat}</td>
                <td className="px-3 py-2">{l.displayName}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  <a
                    href={l.launchUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-600 hover:underline break-all"
                  >
                    {l.launchUrl}
                  </a>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => copyOne(l.launchUrl, l.launchId)}
                    className="btn-secondary text-xs"
                  >
                    {copied === l.launchId ? 'Copied' : 'Copy'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
