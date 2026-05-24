'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { setFlash } from '@/lib/flash';

// ----- Per-launch (seat) actions -----

export async function openLaunchAction(formData: FormData) {
  const launchId = String(formData.get('launchId') ?? '');
  const batchId = String(formData.get('batchId') ?? '');
  if (!launchId) return;
  // Hand off to the fullscreen-capable wrapper. The wrapper itself mints a
  // fresh preview URL on each render, so we don't pre-burn one here.
  if (batchId) {
    redirect(`/dashboard/lab/${launchId}?from=batch&batchId=${batchId}`);
  }
  redirect(`/dashboard/lab/${launchId}`);
}

export async function prepareLaunchAction(formData: FormData) {
  const launchId = String(formData.get('launchId') ?? '');
  const batchId = String(formData.get('batchId') ?? '');
  if (!launchId || !batchId) return;
  const res = await apiFetch<{
    launchId: string;
    instanceId: string;
    status: string;
    ready: boolean;
  }>(`/api/v1/launches/${launchId}/prepare`, {
    method: 'POST',
    body: JSON.stringify({ waitSeconds: 0 }),
  });
  if (!res.ok) {
    await setFlash({
      kind: 'batch-error',
      data: { message: `Prepare failed: ${res.error}` },
    });
  } else {
    await setFlash({
      kind: 'batch-info',
      data: {
        message: `Seat prepared. Instance status: ${res.data.status}${
          res.data.ready ? ' (ready)' : ' — warming up…'
        }`,
      },
    });
  }
  revalidatePath(`/dashboard/batches/${batchId}`);
  redirect(`/dashboard/batches/${batchId}`);
}

export async function revokeLaunchAction(formData: FormData) {
  const launchId = String(formData.get('launchId') ?? '');
  const batchId = String(formData.get('batchId') ?? '');
  if (!launchId || !batchId) return;
  const res = await apiFetch(`/api/v1/launches/${launchId}/revoke`, {
    method: 'POST',
  });
  if (!res.ok) {
    await setFlash({
      kind: 'batch-error',
      data: { message: `Revoke failed: ${res.error}` },
    });
  } else {
    await setFlash({
      kind: 'batch-info',
      data: { message: `Seat URL revoked.` },
    });
  }
  revalidatePath(`/dashboard/batches/${batchId}`);
  redirect(`/dashboard/batches/${batchId}`);
}

export async function regenerateLaunchAction(formData: FormData) {
  const launchId = String(formData.get('launchId') ?? '');
  const batchId = String(formData.get('batchId') ?? '');
  const ttlHours = Number(formData.get('ttlHours') ?? '720');
  if (!launchId || !batchId) return;
  const res = await apiFetch<{
    launchId: string;
    launchUrl: string;
    expiresAt: string;
  }>(`/api/v1/launches/${launchId}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ ttlHours }),
  });
  if (!res.ok) {
    await setFlash({
      kind: 'batch-error',
      data: { message: `Regenerate failed: ${res.error}` },
    });
  } else {
    await setFlash({
      kind: 'batch-fresh-urls',
      data: {
        urls: [
          {
            launchId: res.data.launchId,
            launchUrl: res.data.launchUrl,
            expiresAt: res.data.expiresAt,
          },
        ],
        title: 'New launch URL — copy it now, it will not be shown again.',
      },
    });
  }
  revalidatePath(`/dashboard/batches/${batchId}`);
  redirect(`/dashboard/batches/${batchId}`);
}

// ----- Batch-level actions -----

export async function extendBatchAction(formData: FormData) {
  const batchId = String(formData.get('batchId') ?? '');
  const extendHours = Number(formData.get('extendHours') ?? '24');
  if (!batchId || !Number.isFinite(extendHours) || extendHours <= 0) return;
  const res = await apiFetch<{ extendedSeats: number }>(
    `/api/v1/batches/${batchId}/extend`,
    {
      method: 'POST',
      body: JSON.stringify({ extendHours }),
    },
  );
  await setFlash({
    kind: res.ok ? 'batch-info' : 'batch-error',
    data: {
      message: res.ok
        ? `Extended ${res.data.extendedSeats} seats by ${extendHours}h. Note: JWTs are not re-signed — use Regenerate per seat if a token is past its original expiry.`
        : `Extend failed: ${res.error}`,
    },
  });
  revalidatePath(`/dashboard/batches/${batchId}`);
  redirect(`/dashboard/batches/${batchId}`);
}

export async function terminateBatchAction(formData: FormData) {
  const batchId = String(formData.get('batchId') ?? '');
  const deleteVolumes = formData.get('deleteVolumes') === '1';
  if (!batchId) return;
  const res = await apiFetch<{ terminated: number; revoked: number }>(
    `/api/v1/batches/${batchId}/terminate`,
    {
      method: 'POST',
      body: JSON.stringify({ deleteVolumes }),
    },
  );
  await setFlash({
    kind: res.ok ? 'batch-info' : 'batch-error',
    data: {
      message: res.ok
        ? `Terminated ${res.data.terminated} live instances. Revoked ${res.data.revoked} seat URLs.`
        : `Terminate failed: ${res.error}`,
    },
  });
  revalidatePath(`/dashboard/batches/${batchId}`);
  redirect(`/dashboard/batches/${batchId}`);
}

export async function prepareBatchAction(formData: FormData) {
  const batchId = String(formData.get('batchId') ?? '');
  const concurrency = Number(formData.get('concurrency') ?? '5');
  if (!batchId) return;
  const res = await apiFetch<{
    batchId: string;
    total: number;
    prepared: number;
    resumed: number;
    skipped: number;
    failed: number;
  }>(`/api/v1/batches/${batchId}/prepare`, {
    method: 'POST',
    body: JSON.stringify({ concurrency: Number.isFinite(concurrency) ? concurrency : 5 }),
  });
  await setFlash({
    kind: res.ok ? 'batch-info' : 'batch-error',
    data: {
      message: res.ok
        ? `Prepare run: ${res.data.prepared} provisioned, ${res.data.resumed} resumed, ${res.data.skipped} already live, ${res.data.failed} failed (of ${res.data.total}).`
        : `Prepare all failed: ${res.error}`,
    },
  });
  revalidatePath(`/dashboard/batches/${batchId}`);
  redirect(`/dashboard/batches/${batchId}`);
}

export async function addSeatsAction(formData: FormData) {
  const batchId = String(formData.get('batchId') ?? '');
  const count = Number(formData.get('count') ?? '0');
  if (!batchId || !Number.isFinite(count) || count <= 0) return;
  const res = await apiFetch<{
    batchId: string;
    items: Array<{
      launchId: string;
      seat: number;
      displayName: string;
      launchUrl: string;
      expiresAt: string;
    }>;
  }>(`/api/v1/batches/${batchId}/add-seats`, {
    method: 'POST',
    body: JSON.stringify({ count }),
  });
  if (!res.ok) {
    await setFlash({
      kind: 'batch-error',
      data: { message: `Add seats failed: ${res.error}` },
    });
  } else {
    await setFlash({
      kind: 'batch-fresh-urls',
      data: {
        urls: res.data.items.map((it) => ({
          launchId: it.launchId,
          launchUrl: it.launchUrl,
          expiresAt: it.expiresAt,
          displayName: it.displayName,
          seat: it.seat,
        })),
        title: `${res.data.items.length} new seats — copy these URLs now, they will not be shown again.`,
      },
    });
  }
  revalidatePath(`/dashboard/batches/${batchId}`);
  redirect(`/dashboard/batches/${batchId}`);
}
