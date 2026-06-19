import https from 'node:https';

const API = 'https://api.environments.learnlytica.com';
const API_KEY = '469ef059a99bfac812db75af1ad24301b40654cb8a9d3215b01fe66e58193e74';
const TEMPLATE = 'cmpjhuiwz000al76a8r16auoa';
const COUNT = 10;

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(API + path);
    const opts = { method, hostname: u.hostname, path: u.pathname + u.search, headers: { 'content-type': 'application/json', ...headers } };
    const r = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    r.setTimeout(480000, () => { r.destroy(); resolve({ status: 'TIMEOUT' }); });
    if (data) r.write(data);
    r.end();
  });
}

function redeem(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const start = Date.now();
    const r = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, ms: Date.now() - start }));
    });
    r.on('error', (e) => resolve({ error: String(e) }));
    r.setTimeout(480000, () => { r.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - start }); });
    r.end();
  });
}

const batch = await req('POST', '/api/v1/batches', {
  templateId: TEMPLATE,
  count: COUNT,
  durationMinutes: 120,
  label: 'rdp-fix-scale-10',
}, { authorization: 'Bearer ' + API_KEY });

console.log('BATCH_STATUS', batch.status);
if (batch.status !== 200) { console.log(batch.body); process.exit(1); }
const parsed = JSON.parse(batch.body);
console.log('batchId', parsed.batchId, 'count', parsed.count);

const results = await Promise.all(
  parsed.launches.map(async (l) => {
    const res = await redeem(l.launchUrl);
    const loc = (res.location || '').replace(/^https:\/\//, '').split('.lab.')[0];
    console.log(`seat${l.seat}: status=${res.status} ms=${res.ms} -> ${loc} ${res.error || ''}`);
    return { seat: l.seat, status: res.status };
  })
);

const ok = results.filter((r) => r.status === 302).length;
console.log(`\nDONE: ${ok}/${COUNT} seats returned 302 (ready)`);
