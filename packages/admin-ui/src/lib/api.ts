import { cookies } from 'next/headers';

const API_URL = process.env.LABFORGE_API_URL ?? 'http://localhost:4000';
const COOKIE_NAME = 'lf_admin_key';

export async function getApiKey(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

export const ADMIN_COOKIE_NAME = COOKIE_NAME;

/**
 * Server-side fetch against the control plane. Always uses the tenant's
 * API key from the httpOnly cookie — never exposed to the browser.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const key = await getApiKey();
  if (!key) return { ok: false, status: 401, error: 'no_api_key' };

  const headers = new Headers(init.headers);
  headers.set('X-Api-Key', key);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });

  if (res.status === 204) return { ok: true, data: undefined as T };

  const text = await res.text();
  let payload: unknown = undefined;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }

  if (!res.ok) {
    const err =
      typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : res.statusText;
    return { ok: false, status: res.status, error: err };
  }
  return { ok: true, data: payload as T };
}

export const apiBaseUrl = API_URL;
