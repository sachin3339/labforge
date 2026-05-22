/**
 * End-to-end smoke test:
 *   1. Look up the seeded template by name.
 *   2. Create a launch.
 *   3. Print the launch URL for the human to open in a browser.
 *
 * Env:
 *   API_URL   default http://lab.localhost:4000
 *   API_KEY   default dev-api-key-change-me
 */
const API = process.env.API_URL ?? 'http://lab.localhost:4000';
const KEY = process.env.API_KEY ?? 'dev-api-key-change-me';

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

(async () => {
  const { templates } = await api('/api/v1/templates');
  if (!templates.length) {
    throw new Error('no templates — run `pnpm prisma:seed`');
  }
  const template = templates.find((t) => t.name === 'vscode-node') ?? templates[0];
  console.log(`Using template: ${template.name} (${template.id})`);

  const launch = await api('/api/v1/launches', {
    method: 'POST',
    body: JSON.stringify({
      templateId: template.id,
      userId: 'smoke-user-1',
      userDisplayName: 'Smoke Tester',
      durationMinutes: 60,
    }),
  });

  console.log('\nLaunch URL (open in browser within 60s):');
  console.log(`\n  ${launch.launchUrl}\n`);
  console.log(`Expires at: ${launch.expiresAt}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
