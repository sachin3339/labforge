'use server';

import { cookies } from 'next/headers';

/**
 * Lightweight flash-message helper for transmitting one-time data from a
 * server action to the next page render. Used to display freshly-minted
 * launch URLs (which the control-plane only returns once) without putting
 * them in the URL bar.
 */

const COOKIE = 'lf_flash';

export type FlashPayload = {
  kind: string;
  data: unknown;
};

export async function setFlash(payload: FlashPayload): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, JSON.stringify(payload), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 300, // 5 minutes
  });
}

export async function consumeFlash<T = unknown>(
  kind: string,
): Promise<T | null> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  if (!raw) return null;
  let parsed: FlashPayload;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeDelete(store);
    return null;
  }
  if (parsed.kind !== kind) return null;
  safeDelete(store);
  return parsed.data as T;
}

// Cookie mutation is only legal inside a Server Action or Route Handler. When
// `consumeFlash` is called from a Server Component render (the common case),
// the delete throws and crashes the whole page. Swallow it — the cookie has
// a 5-minute TTL and gets overwritten on the next flash anyway.
function safeDelete(store: Awaited<ReturnType<typeof cookies>>): void {
  try {
    store.delete(COOKIE);
  } catch {
    // ignored: cannot mutate cookies during render
  }
}
