'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

/**
 * Full-bleed iframe wrapper with browser-fullscreen controls.
 *
 * Why a wrapper rather than redirecting straight to the lab URL?
 *   1. Lets us trigger element.requestFullscreen() on the iframe — this
 *      hides the OS chrome / address bar / tab strip for a kiosk feel.
 *   2. Lets us provide a consistent "back to admin" affordance regardless
 *      of the upstream lab's own UI.
 *
 * Fullscreen requires a user gesture (no auto-trigger on load) so we
 * surface a prominent button + an Esc hint.
 */
export function LabFrame({
  src,
  launchId,
  nodeName,
  templateName,
}: {
  src: string;
  launchId: string;
  nodeName?: string | null;
  templateName?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFs, setIsFs] = useState(false);

  // Track fullscreen state so the button label flips. Listens on the
  // document because Esc-exit doesn't fire a click on our button.
  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Hand keyboard focus to the iframe so the student can type immediately on
  // open. Guacamole's keyboard handler lives inside the (cross-origin) iframe
  // document and only receives key events while the iframe is focused —
  // without this, keystrokes go to *this* parent page and never reach the VM,
  // which reads as "I can't type in the VM" right after opening. We re-focus
  // on initial mount and again whenever this window regains focus (e.g. after
  // alt-tab) so the keyboard keeps working without a manual click.
  const focusFrame = () => {
    // Defer a tick so the focus lands after any click/route handling.
    requestAnimationFrame(() => {
      try { iframeRef.current?.focus(); } catch { /* noop */ }
    });
  };

  useEffect(() => {
    focusFrame();
    window.addEventListener('focus', focusFrame);
    return () => window.removeEventListener('focus', focusFrame);
  }, []);

  const enterFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      // Fullscreen the wrapper (not just the iframe) so our control bar
      // stays accessible inside fullscreen mode.
      await el.requestFullscreen({ navigationUI: 'hide' });
      // Re-focus the iframe after the fullscreen transition so typing keeps
      // working in fullscreen (the transition can steal focus).
      focusFrame();
    } catch {
      /* user-gesture or permissions issue — fall back to no-op */
    }
  };

  const exitFullscreen = async () => {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* noop */ }
    }
  };

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex flex-col bg-ink-900 text-ink-50"
      onMouseDown={focusFrame}
    >
      {/* Slim control bar (auto-hides in fullscreen via group-hover trick) */}
      <div className="flex items-center justify-between gap-3 border-b border-ink-700 bg-ink-900/95 px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/instances"
            className="text-ink-50/70 hover:text-ink-50"
          >
            ← Back
          </Link>
          <span className="font-mono text-ink-50/50">launch {launchId.slice(0, 8)}…</span>
          {templateName && (
            <span className="hidden sm:inline rounded-md bg-ink-800 px-2 py-0.5 text-ink-50/70">
              {templateName}
            </span>
          )}
          {nodeName && (
            <span
              className="rounded-md bg-sky-600/30 px-2 py-0.5 text-sky-100 ring-1 ring-sky-400/40"
              title="Physical host running this container"
            >
              node: {nodeName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-ink-700 px-2.5 py-1 text-ink-50/80 hover:bg-ink-800"
            title="Open the lab in a separate tab"
          >
            Open in new tab ↗
          </a>
          {isFs ? (
            <button
              type="button"
              onClick={exitFullscreen}
              className="rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 font-medium hover:bg-ink-700"
            >
              Exit full screen (Esc)
            </button>
          ) : (
            <button
              type="button"
              onClick={enterFullscreen}
              className="rounded-md border border-brand-400/60 bg-brand-500/20 px-2.5 py-1 font-medium text-brand-100 hover:bg-brand-500/30"
            >
              Full screen
            </button>
          )}
        </div>
      </div>

      <iframe
        ref={iframeRef}
        src={src}
        title="Lab session"
        onLoad={focusFrame}
        // allow: clipboard so VS Code copy/paste works; fullscreen so the
        // KasmVNC desktop's own "FS" button continues to function inside
        // our wrapper; the rest are quality-of-life passes.
        allow="clipboard-read; clipboard-write; fullscreen; autoplay; microphone; camera"
        // sandbox left OFF on purpose — lab subdomain is trusted and needs
        // full DOM access for KasmVNC / code-server / Jupyter to work.
        className="flex-1 border-0 bg-black"
      />
    </div>
  );
}
