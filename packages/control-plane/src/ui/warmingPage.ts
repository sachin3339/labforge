/**
 * Branded "your lab is starting" HTML page. Used by both the redeem
 * endpoint (first launch / cold resume) and the wildcard proxy (student
 * hits a bookmark while the lab is suspended). Auto-refreshes every 3s
 * so once the upstream is healthy the student lands on their lab.
 */
export function warmingUpHtml(templateName: string): string {
  const safe = templateName.replace(/[<>&"']/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="3" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Starting your lab… — LabForge</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      display: grid; place-items: center; min-height: 100vh; margin: 0;
      background: #0f172a; color: #e2e8f0;
    }
    .card {
      max-width: 480px; padding: 2.5rem; text-align: center;
      background: #1e293b; border: 1px solid #334155; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; font-weight: 600; }
    p { color: #94a3b8; margin: 0.25rem 0; font-size: 0.9rem; }
    .spinner {
      width: 36px; height: 36px; margin: 0 auto 1.5rem;
      border: 3px solid #334155; border-top-color: #38bdf8; border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    .tmpl { color: #38bdf8; font-weight: 500; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Starting your <span class="tmpl">${safe}</span> lab</h1>
    <p>This usually takes a few seconds.</p>
    <p>Windows labs can take up to a minute to wake up.</p>
    <p style="margin-top: 1.25rem; font-size: 0.75rem; opacity: 0.6;">
      This page refreshes automatically.
    </p>
  </div>
</body>
</html>`;
}

/**
 * Minimal "lab unavailable" HTML page \u2014 served by the proxy when a
 * student hits a subdomain whose instance has been terminated or expired.
 * Stays simple so it works even when the rest of the system is degraded.
 */
export function unavailableHtml(reason: string): string {
  const safe = reason.replace(/[<>&"']/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lab unavailable \u2014 LabForge</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      display: grid; place-items: center; min-height: 100vh; margin: 0;
      background: #0f172a; color: #e2e8f0;
    }
    .card {
      max-width: 460px; padding: 2.5rem; text-align: center;
      background: #1e293b; border: 1px solid #334155; border-radius: 12px;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
    p { color: #94a3b8; margin: 0.25rem 0; font-size: 0.9rem; }
    code { font-size: 0.75rem; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>This lab is no longer available</h1>
    <p>Your batch may have ended, or this session has expired.</p>
    <p>Please return to your course and open the lab link again.</p>
    <p style="margin-top: 1.5rem;"><code>${safe}</code></p>
  </div>
</body>
</html>`;
}
