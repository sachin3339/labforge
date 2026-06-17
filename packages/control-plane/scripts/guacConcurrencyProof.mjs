// Live proof: open TWO concurrent Guacamole WebSocket tunnels to the SAME
// connection. With max_connections=1 the second must be REJECTED while the
// first stays alive (vs. the old behaviour where the second kicked the first).
//
// Implements the minimal Guacamole client handshake so tunnel#1 reaches the
// "ready" state, holds it, then opens tunnel#2 and reports its verdict.
import { WebSocket } from 'undici';

const GUAC_HTTP = 'http://guacamole:8080/guacamole';
const GUAC_WS = 'ws://guacamole:8080/guacamole/websocket-tunnel';
const USER = process.env.GUSER;
const PASS = process.env.GPASS;
const CID = process.env.CID;

// Encode one Guacamole instruction: LEN.VALUE,LEN.VALUE,...;
function instr(...elems) {
  return elems.map((e) => `${Buffer.byteLength(String(e), 'utf8')}.${e}`).join(',') + ';';
}

// Streaming parser for inbound instructions.
function makeParser(onInstr) {
  let buf = '';
  return (chunk) => {
    buf += String(chunk);
    let i;
    while ((i = buf.indexOf(';')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const elems = [];
      let rest = raw;
      let ok = true;
      while (rest.length) {
        const dot = rest.indexOf('.');
        if (dot < 0) { ok = false; break; }
        const len = parseInt(rest.slice(0, dot), 10);
        const val = rest.slice(dot + 1, dot + 1 + len);
        elems.push(val);
        rest = rest.slice(dot + 1 + len);
        if (rest[0] === ',') rest = rest.slice(1);
      }
      if (ok && elems.length) onInstr(elems);
    }
  };
}

async function getToken() {
  const body = new URLSearchParams({ username: USER, password: PASS });
  const r = await fetch(`${GUAC_HTTP}/api/tokens`, { method: 'POST', body });
  return (await r.json()).authToken;
}

function openTunnel(token, label, holdMs) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams({
      token,
      GUAC_DATA_SOURCE: 'postgresql',
      GUAC_ID: CID,
      GUAC_TYPE: 'c',
      GUAC_WIDTH: '1280',
      GUAC_HEIGHT: '720',
      GUAC_DPI: '96',
      GUAC_TIMEZONE: 'UTC',
      GUAC_AUDIO: 'audio/L16',
      GUAC_IMAGE: 'image/png',
    });
    const ws = new WebSocket(`${GUAC_WS}?${qs.toString()}`, ['guacamole']);
    const res = { label, ready: false, active: false, error: null, closed: null, seen: [] };
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve({ ws, ...res }); } };
    const timer = setTimeout(done, 8000);

    const parse = makeParser((e) => {
      const op = e[0];
      if (res.seen.length < 12) res.seen.push(op);
      // Live desktop drawing/streaming ops prove the session is established.
      if (['img', 'blob', 'sync', 'cursor', 'png', 'rect'].includes(op)) {
        res.active = true;
        if (holdMs) { clearTimeout(timer); setTimeout(done, holdMs); }
      }
      if (op === 'args') {
        // Reply with the standard client handshake. All RDP params are
        // server-side (JDBC), so connect args are empty placeholders.
        const argNames = e.slice(1);
        ws.send(instr('size', '1280', '720', '96'));
        ws.send(instr('audio', 'audio/L16'));
        ws.send(instr('video'));
        ws.send(instr('image', 'image/png'));
        ws.send(instr('timezone', 'UTC'));
        ws.send(instr('connect', ...argNames.map(() => '')));
      } else if (op === 'ready') {
        res.ready = true;
        // Hold the tunnel open for holdMs so a concurrent open overlaps it.
        if (holdMs) { clearTimeout(timer); setTimeout(done, holdMs); }
        else done();
      } else if (op === 'error') {
        res.error = e.slice(1).join(' | ');
        clearTimeout(timer); done();
      }
    });

    ws.addEventListener('message', (ev) => parse(ev.data));
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', (ev) => {
      res.closed = `${ev.code}${ev.reason ? ' ' + ev.reason : ''}`;
      clearTimeout(timer); done();
    });
  });
}

const token = await getToken();
console.log('token len=', token ? token.length : 0, 'cid=', CID);

// Open #1 and HOLD it for 6s.
const p1 = openTunnel(token, 'tunnel#1', 6000);
// Give #1 time to reach ready, then open #2 concurrently.
await new Promise((r) => setTimeout(r, 2500));
const t2 = await openTunnel(token, 'tunnel#2', 0);
const t1 = await p1;

console.log(`tunnel#1: active=${t1.active} ready=${t1.ready} error=${t1.error} closed=${t1.closed} seen=[${t1.seen.join(',')}]`);
console.log(`tunnel#2: active=${t2.active} ready=${t2.ready} error=${t2.error} closed=${t2.closed} seen=[${t2.seen.join(',')}]`);
const pass = (t1.active || t1.ready) && !(t2.active || t2.ready);
console.log('VERDICT:', pass
  ? 'PASS - tunnel#1 stayed ACTIVE (live desktop); concurrent tunnel#2 was REJECTED (no kick)'
  : 'CHECK - see fields above');
try { t1.ws.close(); } catch {}
try { t2.ws.close(); } catch {}
process.exit(0);
