import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME, apiBaseUrl, getApiKey } from '@/lib/api';
import { SubmitButton } from '@/components/submit-button';

async function login(formData: FormData) {
  'use server';
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!apiKey) return;

  // Validate by hitting /api/v1/admin/me
  const res = await fetch(`${apiBaseUrl}/api/v1/admin/me`, {
    headers: { 'X-Api-Key': apiKey },
    cache: 'no-store',
  });
  if (!res.ok) {
    redirect('/login?error=invalid');
  }

  const store = await cookies();
  store.set(ADMIN_COOKIE_NAME, apiKey, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12, // 12h
  });
  redirect('/dashboard');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const existing = await getApiKey();
  if (existing) redirect('/dashboard');
  const { error } = await searchParams;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-brand-50 via-white to-accent-50 px-4">
      {/* Decorative grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(99,102,241,0.08) 1px, transparent 1px),linear-gradient(90deg, rgba(99,102,241,0.08) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          maskImage:
            'radial-gradient(ellipse at center, black 40%, transparent 70%)',
        }}
      />
      {/* Soft blobs */}
      <div className="pointer-events-none absolute -left-32 -top-32 h-72 w-72 rounded-full bg-brand-400/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-72 w-72 rounded-full bg-accent-400/20 blur-3xl" />

      <div className="relative w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white shadow-elevated">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
            </svg>
          </span>
          <span className="text-lg font-semibold tracking-tight">LabForge</span>
        </div>

        <form
          action={login}
          className="rounded-2xl border border-ink-200/70 bg-white/90 p-7 shadow-elevated backdrop-blur"
          autoComplete="off"
        >
          <header className="mb-5">
            <h1 className="text-xl font-semibold tracking-tight">Sign in to your tenant</h1>
            <p className="mt-1 text-sm text-ink-600">
              Use your tenant API key to access the admin console.
            </p>
          </header>

          {error === 'invalid' && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              That key wasn&apos;t recognised. Double-check and try again.
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-[0.08em] text-ink-600">
              API key
            </span>
            <input
              name="apiKey"
              type="password"
              className="input font-mono"
              placeholder="lf_..."
              required
              autoFocus
            />
          </label>

          <SubmitButton
            variant="primary"
            className="mt-5 w-full"
            pendingLabel="Signing in…"
          >
            Sign in
          </SubmitButton>

          <p className="mt-5 border-t border-ink-100 pt-4 text-xs text-ink-500">
            Default dev key:{' '}
            <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-ink-700">
              dev-api-key-change-me
            </code>
          </p>
        </form>

        <p className="mt-6 text-center text-[11px] text-ink-500">
          © {new Date().getFullYear()} LabForge · Tenant admin console
        </p>
      </div>
    </main>
  );
}
