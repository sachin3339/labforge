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

  const curlSnippet = `# 1. List the templates available to your tenant
curl -H "Authorization: Bearer ${t.apiKey}" \\
  ${PUBLIC_API}/api/v1/templates

# 2. Create a BATCH of long-lived launch URLs (recommended for cohorts).
#    Returns N independent, single-use URLs valid for ttlHours (default 30 days).
curl -X POST -H "Authorization: Bearer ${t.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "templateId":      "<TEMPLATE_ID>",
    "label":           "DevOps-Cohort-March",
    "count":           25,
    "durationMinutes": 120,
    "ttlHours":        720,
    "seatNames":       ["Jane Doe","John Smith"]
  }' \\
  ${PUBLIC_API}/api/v1/batches
# → returns { batchId, launches: [{ launchUrl, displayName, ... }, ...] }
# Email each launchUrl to the corresponding learner.

# 3. (Alternative) Create a SINGLE short-lived launch — token valid 60s,
#    intended for an LMS that redirects the student in the same response.
curl -X POST -H "Authorization: Bearer ${t.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "templateId":      "<TEMPLATE_ID>",
    "userId":          "student-12345",
    "userDisplayName": "Jane Doe",
    "durationMinutes": 120
  }' \\
  ${PUBLIC_API}/api/v1/launches

# 4. Revoke an entire batch (kills live VMs + disables remaining URLs)
curl -X POST -H "Authorization: Bearer ${t.apiKey}" \\
  ${PUBLIC_API}/api/v1/batches/<BATCH_ID>/terminate`;

  const nodeSnippet = `import fetch from 'node-fetch';

const API = '${PUBLIC_API}';
const KEY = '${t.apiKey}';

const headers = {
  'Authorization': \`Bearer \${KEY}\`,
  'Content-Type': 'application/json',
};

// ---- List templates (use these IDs in createBatch / createLaunch) ----
async function listTemplates() {
  const r = await fetch(\`\${API}/api/v1/templates\`, { headers });
  return (await r.json()).templates;
}

// ---- Create a batch of N launch URLs (recommended) -----------------
// One call per cohort. Each URL is independent, long-lived, and
// boots a fresh VM/lab for the learner who opens it.
async function createBatch({ templateId, label, count, seatNames }) {
  const r = await fetch(\`\${API}/api/v1/batches\`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      templateId,
      label,            // e.g. "DevOps-Cohort-March"
      count,            // 1..500
      durationMinutes: 120,
      ttlHours: 720,    // URL valid 30 days; lab session = durationMinutes
      seatNames,        // optional; length must equal count
      // webhookUrl: 'https://your.app/labforge-events', // optional
    }),
  });
  const data = await r.json();
  return data.launches;  // [{ launchId, seat, displayName, launchUrl, expiresAt }, ...]
}

// ---- Create a single launch (LMS-style, token expires in 60s) ------
async function createLaunch({ templateId, userId, userName }) {
  const r = await fetch(\`\${API}/api/v1/launches\`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      templateId,
      userId,
      userDisplayName: userName,
      durationMinutes: 120,
    }),
  });
  return (await r.json()).launchUrl;  // redirect the browser here immediately
}

// ---- Lifecycle -----------------------------------------------------
async function revokeBatch(batchId)    { await fetch(\`\${API}/api/v1/batches/\${batchId}\`,            { method: 'DELETE', headers }); }
async function terminateBatch(batchId) { await fetch(\`\${API}/api/v1/batches/\${batchId}/terminate\`, { method: 'POST',   headers }); }`;

  const iframeSnippet = `<!-- Embed a launchUrl returned by /api/v1/batches or /api/v1/launches -->
<iframe
  src="\${launchUrl}"
  allow="clipboard-read; clipboard-write; fullscreen"
  style="width: 100%; height: 800px; border: 0;"
></iframe>

<!-- The first request to launchUrl provisions the VM/container,
     sets a session cookie, then redirects into the live lab. -->`;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <div className="flex items-center justify-between">
          <div>
            <Link
              href="/dashboard/platform/tenants"
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              ← All tenants
            </Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t.name}</h1>
            <p className="mt-1 text-sm text-ink-600">
              Tenant <span className="font-mono text-ink-700">{t.id}</span> · role{' '}
              <span className="badge badge-muted">{t.role}</span> · created{' '}
              {new Date(t.createdAt).toLocaleDateString()}
            </p>
          </div>
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
          The standard flow: list templates, then create a <strong>batch</strong>{' '}
          of long-lived launch URLs (one per learner). Each URL boots a
          fresh isolated VM/lab the moment the learner opens it.
        </p>
        <CodeBlock code={curlSnippet} />
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Node.js example</h2>
        <p className="text-xs text-ink-900/60">
          Full integration: list templates, create batches, single launches,
          and lifecycle (revoke / terminate). Drop into any Node 18+ service.
        </p>
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
