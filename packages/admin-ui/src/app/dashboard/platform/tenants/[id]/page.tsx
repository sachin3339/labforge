import Link from 'next/link';
import { apiFetch, apiBaseUrl } from '@/lib/api';
import { CopyButton } from '@/components/copy-button';

type TenantDetail = {
  id: string;
  name: string;
  apiKey: string;
  role: string;
  webhookSecret: string;
  createdAt: string;
  _count: { templates: number; instances: number; launches: number };
};

// Strip any internal hostname (control-plane:4000) and prefer the public API URL.
const PUBLIC_API =
  process.env.PUBLIC_LABFORGE_API_URL ?? 'https://api.environments.learnlytica.com';

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiFetch<{ tenant: TenantDetail }>(
    `/api/v1/platform/tenants/${id}`,
  );
  if (!res.ok) {
    return (
      <div className="card text-sm text-red-600">
        Error: {res.error}
      </div>
    );
  }
  const t = res.data.tenant;

  const curlSnippet = `# 1. List your templates
curl -H "Authorization: Bearer ${t.apiKey}" \\
  ${PUBLIC_API}/api/v1/templates

# 2. Create a single-use launch for a student
curl -X POST -H "Authorization: Bearer ${t.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "templateId": "<TEMPLATE_ID>",
    "userId": "student-12345",
    "userDisplayName": "Jane Doe",
    "durationMinutes": 120
  }' \\
  ${PUBLIC_API}/api/v1/launches
# → returns { "launchUrl": "https://..." } — hand this URL to the student.`;

  const nodeSnippet = `import fetch from 'node-fetch';

const API = '${PUBLIC_API}';
const KEY = '${t.apiKey}';

// Create a lab launch URL for one student
async function createLaunch(templateId, userId, userName) {
  const res = await fetch(\`\${API}/api/v1/launches\`, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      templateId,
      userId,
      userDisplayName: userName,
      durationMinutes: 120,
    }),
  });
  const { launchUrl } = await res.json();
  return launchUrl;  // give this URL to the student
}`;

  const iframeSnippet = `<!-- Embed in your LMS / portal -->
<iframe
  src="\${launchUrl}"
  allow="clipboard-read; clipboard-write; fullscreen"
  style="width: 100%; height: 800px; border: 0;"
></iframe>`;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <Link
            href="/dashboard/platform/tenants"
            className="text-xs text-brand-700 hover:underline"
          >
            ← All tenants
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{t.name}</h1>
          <p className="text-sm text-ink-900/60">
            Tenant {t.id} · role <strong>{t.role}</strong> · created{' '}
            {new Date(t.createdAt).toLocaleDateString()}
          </p>
        </div>
      </header>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Credentials</h2>
        <Field
          label="API base URL"
          value={PUBLIC_API}
          hint="Use this as the base for all API calls."
        />
        <Field
          label="API key"
          value={t.apiKey}
          hint="Send as `Authorization: Bearer <key>` or `X-Api-Key` header. Treat as a secret."
          secret
        />
        <Field
          label="Webhook secret (HMAC)"
          value={t.webhookSecret}
          hint="Used to sign outbound webhook payloads. Verify with HMAC-SHA256."
          secret
        />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Quick start — curl</h2>
        <p className="text-xs text-ink-900/60">
          Two-step integration: list templates, then create a launch URL per student.
        </p>
        <CodeBlock code={curlSnippet} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Node.js example</h2>
        <CodeBlock code={nodeSnippet} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Embed in your portal</h2>
        <p className="text-xs text-ink-900/60">
          The returned <code>launchUrl</code> is a single-use signed URL. Open
          it once (e.g. in an iframe) and the user gets a session cookie scoped
          to that lab.
        </p>
        <CodeBlock code={iframeSnippet} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Stats</h2>
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Templates" value={t._count.templates} />
          <Stat label="Instances" value={t._count.instances} />
          <Stat label="Launches" value={t._count.launches} />
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  hint,
  secret,
}: {
  label: string;
  value: string;
  hint?: string;
  secret?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-ink-900/70">{label}</label>
        <CopyButton text={value} />
      </div>
      <div
        className={
          'mt-1 break-all rounded-md bg-ink-50 px-3 py-2 font-mono text-xs ' +
          (secret ? 'border border-amber-200' : '')
        }
      >
        {value}
      </div>
      {hint && <p className="mt-1 text-[11px] text-ink-900/60">{hint}</p>}
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto rounded-md bg-ink-900 p-4 text-xs leading-relaxed text-ink-50">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-white px-3 py-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-ink-900/60">
        {label}
      </div>
    </div>
  );
}
