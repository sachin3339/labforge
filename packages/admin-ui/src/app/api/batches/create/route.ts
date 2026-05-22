import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const API_URL = process.env.LABFORGE_API_URL ?? 'http://localhost:4000';
const COOKIE_NAME = 'lf_admin_key';

/**
 * Browser-callable proxy so the admin UI can POST /batches without ever
 * exposing the tenant API key to JS. We read the httpOnly cookie here on
 * the Next.js server, forward to the control plane, and pass the JSON
 * response straight back.
 */
export async function POST(req: NextRequest) {
  const store = await cookies();
  const key = store.get(COOKIE_NAME)?.value;
  if (!key) {
    return NextResponse.json({ error: 'no_api_key' }, { status: 401 });
  }
  const body = await req.text();
  const upstream = await fetch(`${API_URL}/api/v1/batches`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
    },
    body,
    cache: 'no-store',
  });
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
