import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME, apiBaseUrl, getApiKey } from '@/lib/api';

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
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        action={login}
        className="card w-full max-w-md space-y-5"
        autoComplete="off"
      >
        <header>
          <h1 className="text-xl font-semibold">LabForge Admin</h1>
          <p className="mt-1 text-sm text-ink-900/60">
            Enter your tenant API key to sign in.
          </p>
        </header>
        {error === 'invalid' && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            That key wasn&apos;t recognised. Double-check and try again.
          </div>
        )}
        <label className="block">
          <span className="mb-1 block text-sm font-medium">API key</span>
          <input
            name="apiKey"
            type="password"
            className="input font-mono"
            placeholder="lf_..."
            required
            autoFocus
          />
        </label>
        <button className="btn-primary w-full" type="submit">
          Sign in
        </button>
        <p className="text-xs text-ink-900/50">
          Default dev key: <code className="font-mono">dev-api-key-change-me</code>
        </p>
      </form>
    </main>
  );
}
