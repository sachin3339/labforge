'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { setFlash } from '@/lib/flash';

/**
 * Rename a batch — updates `batchLabel` on every Launch.context JSON for
 * the batch. Invoked from the inline edit form on the batches list.
 */
export async function renameBatchAction(formData: FormData) {
  const batchId = String(formData.get('batchId') ?? '');
  const label = String(formData.get('label') ?? '').trim();
  if (!batchId || !label) {
    await setFlash({
      kind: 'batch-error',
      data: { message: 'Rename failed: label is required.' },
    });
    revalidatePath('/dashboard/batches');
    redirect('/dashboard/batches');
  }
  const res = await apiFetch<{ updated: number; label: string }>(
    `/api/v1/batches/${batchId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    },
  );
  await setFlash({
    kind: res.ok ? 'batch-info' : 'batch-error',
    data: {
      message: res.ok
        ? `Renamed batch to "${res.data.label}" (${res.data.updated} seats updated).`
        : `Rename failed: ${res.error}`,
    },
  });
  revalidatePath('/dashboard/batches');
  redirect('/dashboard/batches');
}

/**
 * Destructive delete — terminates every live instance in the batch and
 * then removes the Launch rows so the batch disappears from the list.
 * The confirmation lives in the form template (native <details>).
 */
export async function purgeBatchAction(formData: FormData) {
  const batchId = String(formData.get('batchId') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  if (!batchId) return;
  if (confirm !== 'DELETE') {
    await setFlash({
      kind: 'batch-error',
      data: {
        message: 'Delete cancelled: type DELETE in the confirmation box.',
      },
    });
    revalidatePath('/dashboard/batches');
    redirect('/dashboard/batches');
  }
  const res = await apiFetch<{ terminated: number; deleted: number }>(
    `/api/v1/batches/${batchId}/purge`,
    { method: 'DELETE' },
  );
  await setFlash({
    kind: res.ok ? 'batch-info' : 'batch-error',
    data: {
      message: res.ok
        ? `Deleted batch: terminated ${res.data.terminated} instances and removed ${res.data.deleted} seats.`
        : `Delete failed: ${res.error}`,
    },
  });
  revalidatePath('/dashboard/batches');
  redirect('/dashboard/batches');
}
