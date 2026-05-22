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
    store.delete(COOKIE);
    return null;
  }
  if (parsed.kind !== kind) return null;
  store.delete(COOKIE);
  return parsed.data as T;
}
