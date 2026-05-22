'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';

/**
 * Server actions for the Instances admin page. Each one calls the matching
 * /api/v1/admin/instances/:id/... endpoint and revalidates the cache so the
 * table refreshes after the form post completes.
 */

export async function openLaunchAction(formData: FormData) {
  const launchId = String(formData.get('launchId') ?? '');
  if (!launchId) return;
  const res = await apiFetch<{ url: string }>(
    `/api/v1/launches/${launchId}/preview-url`,
    { method: 'POST' },
  );
  if (!res.ok) {
    redirect(`/dashboard/instances?openErr=${encodeURIComponent(res.error)}`);
  }
  redirect(res.data.url);
}

export async function suspendAction(formData: FormData) {
  const id = String(formData.get('instanceId') ?? '');
  if (!id) return;
  await apiFetch(`/api/v1/admin/instances/${id}/suspend`, { method: 'POST' });
  revalidatePath('/dashboard/instances');
  revalidatePath(`/dashboard/instances/${id}`);
}

export async function resumeAction(formData: FormData) {
  const id = String(formData.get('instanceId') ?? '');
  if (!id) return;
  await apiFetch(`/api/v1/admin/instances/${id}/resume`, { method: 'POST' });
  revalidatePath('/dashboard/instances');
  revalidatePath(`/dashboard/instances/${id}`);
}

export async function restartAction(formData: FormData) {
  const id = String(formData.get('instanceId') ?? '');
  if (!id) return;
  await apiFetch(`/api/v1/admin/instances/${id}/restart`, { method: 'POST' });
  revalidatePath('/dashboard/instances');
  revalidatePath(`/dashboard/instances/${id}`);
}

export async function terminateAction(formData: FormData) {
  const id = String(formData.get('instanceId') ?? '');
  const deleteVolume = formData.get('deleteVolume') === '1';
  if (!id) return;
  await apiFetch(`/api/v1/admin/instances/${id}/terminate`, {
    method: 'POST',
    body: JSON.stringify({ deleteVolume }),
  });
  revalidatePath('/dashboard/instances');
}

export async function extendAction(formData: FormData) {
  const id = String(formData.get('instanceId') ?? '');
  const hours = Number(formData.get('extendHours') ?? '24');
  if (!id || !Number.isFinite(hours) || hours <= 0) return;
  await apiFetch(`/api/v1/admin/instances/${id}/extend`, {
    method: 'POST',
    body: JSON.stringify({ extendHours: hours }),
  });
  revalidatePath('/dashboard/instances');
  revalidatePath(`/dashboard/instances/${id}`);
}

export async function gradeAction(formData: FormData) {
  const id = String(formData.get('instanceId') ?? '');
  if (!id) return;
  const res = await apiFetch<
    { score: number; maxScore: number; passed: boolean } | { error: string; message?: string }
  >(`/api/v1/grading/instances/${id}`, { method: 'POST' });
  revalidatePath('/dashboard/instances');
  if (!res.ok) {
    redirect(`/dashboard/instances?gradeErr=${encodeURIComponent(res.error)}`);
  }
  const d = res.data;
  if ('error' in d) {
    redirect(
      `/dashboard/instances?gradeErr=${encodeURIComponent(d.error)}&msg=${encodeURIComponent(d.message ?? '')}`,
    );
  }
  redirect(
    `/dashboard/instances?graded=${encodeURIComponent(id)}&score=${d.score}&max=${d.maxScore}&passed=${d.passed ? '1' : '0'}`,
  );
}
