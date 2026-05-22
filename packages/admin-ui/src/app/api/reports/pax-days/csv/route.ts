import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const API_URL = process.env.LABFORGE_API_URL ?? 'http://localhost:4000';
const COOKIE_NAME = 'lf_admin_key';

/**
 * Server-proxied CSV download for /reports/pax-days. The control plane
 * requires X-Api-Key, which the browser doesn't carry. This route reads
 * the httpOnly admin cookie, calls the backend with `format=csv`, and
 * streams the response back as an attachment.
 */
export async function GET(req: NextRequest) {
  const store = await cookies();
  const key = store.get(COOKIE_NAME)?.value;
  if (!key) {
    return NextResponse.json({ error: 'no_api_key' }, { status: 401 });
  }
  const incoming = new URL(req.url);
  const qs = new URLSearchParams(incoming.searchParams);
  qs.set('format', 'csv');

  const upstream = await fetch(
    `${API_URL}/api/v1/reports/pax-days?${qs.toString()}`,
    { headers: { 'x-api-key': key }, cache: 'no-store' },
  );
  const text = await upstream.text();
  if (!upstream.ok) {
    return NextResponse.json(
      { error: 'upstream_failed', detail: text },
      { status: upstream.status },
    );
  }
  return new NextResponse(text, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition':
        upstream.headers.get('content-disposition') ??
        'attachment; filename="pax-days.csv"',
      'cache-control': 'no-store',
    },
  });
}
