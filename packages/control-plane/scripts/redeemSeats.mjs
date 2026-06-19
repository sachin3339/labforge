import https from 'node:https';

const urls = [
  process.argv[2],
  process.argv[3],
].filter(Boolean);

function redeem(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = { method: 'GET', hostname: u.hostname, path: u.pathname + u.search, headers: {} };
    const start = Date.now();
    const r = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, ms: Date.now() - start, body: buf.slice(0, 200) }));
    });
    r.on('error', (e) => resolve({ error: String(e) }));
    r.setTimeout(420000, () => { r.destroy(); resolve({ status: 'TIMEOUT', ms: Date.now() - start }); });
    r.end();
  });
}

for (let i = 0; i < urls.length; i++) {
  const res = await redeem(urls[i]);
  console.log(`seat${i + 1}: status=${res.status} ms=${res.ms} loc=${(res.location || '').slice(0, 80)} ${res.error || ''}`);
}
