import https from 'node:https';

const API = 'https://api.environments.learnlytica.com';
const API_KEY = '469ef059a99bfac812db75af1ad24301b40654cb8a9d3215b01fe66e58193e74';
const TEMPLATE = 'cmpjhuiwz000al76a8r16auoa';

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(API + path);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', ...headers },
    };
    const r = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const batch = await req('POST', '/api/v1/batches', {
  templateId: TEMPLATE,
  count: 2,
  durationMinutes: 120,
  label: 'rdp-fix-smoke-2',
}, { authorization: 'Bearer ' + API_KEY });

console.log('BATCH_STATUS', batch.status);
console.log(batch.body);
