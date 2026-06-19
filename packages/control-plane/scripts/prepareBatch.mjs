import https from 'node:https';

const API = 'https://api.environments.learnlytica.com';
const API_KEY = '469ef059a99bfac812db75af1ad24301b40654cb8a9d3215b01fe66e58193e74';
const BATCH = process.argv[2] || 'b_lV7KP0dO1A00';
const CONC = Number(process.argv[3] || 2);

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(API + path);
    const r = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    r.on('error', reject);
    r.setTimeout(1800000, () => { r.destroy(); resolve({ status: 'TIMEOUT' }); });
    if (data) r.write(data);
    r.end();
  });
}

const start = Date.now();
const res = await req('POST', `/api/v1/batches/${BATCH}/prepare`, { concurrency: CONC });
console.log('PREPARE_STATUS', res.status, `(${Math.round((Date.now() - start) / 1000)}s)`);
console.log(res.body);
