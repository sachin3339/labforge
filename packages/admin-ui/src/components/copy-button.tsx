'use client';

import { useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="rounded-md border border-ink-200 bg-white px-2 py-1 text-[10px] font-medium text-ink-700 shadow-sm hover:bg-ink-50"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
