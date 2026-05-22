'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'warning' | 'plain';

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  success:
    'inline-flex items-center justify-center gap-1.5 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 transition hover:bg-emerald-100',
  warning:
    'inline-flex items-center justify-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-100',
  plain:
    'inline-flex items-center justify-center gap-1.5 rounded border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-ink-800 transition hover:bg-ink-50',
};

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M4 12a8 8 0 0 1 8-8"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SubmitButton({
  children,
  pendingLabel,
  variant = 'secondary',
  className = '',
  title,
  disabled,
}: {
  children: ReactNode;
  pendingLabel?: ReactNode;
  variant?: Variant;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      title={title}
      disabled={pending || disabled}
      aria-busy={pending}
      className={`${VARIANT_CLASS[variant]} ${className} disabled:cursor-wait disabled:opacity-70`}
    >
      {pending ? (
        <>
          <Spinner />
          <span>{pendingLabel ?? 'Working…'}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
