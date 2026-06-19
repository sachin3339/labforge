// Decisive server-side keyboard test. Opens a Guacamole WebSocket tunnel to
// CID, waits for the live desktop, then presses the Windows (Super_L) key
// which MUST open the Start menu — a large guaranteed screen change. We
// measure drawing-op volume in an idle window vs. the window right after the
// keypress. A burst after the key proves keystrokes register server-side.
import { WebSocket } from 'undici';

const GUAC_HTTP = 'http://guacamole:8080/guacamole';
const GUAC_WS = 'ws://guacamole:8080/guacamole/websocket-tunnel';
const USER = process.env.GUSER;
const PASS = process.env.GPASS;
const CID = process.env.CID;

function instr(...elems) {
  return elems.map((e) => `${Buffer.byteLength(String(e), 'utf8')}.${e}`).join(',') + ';';
}

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

const DRAW_OPS = new Set(['img', 'blob', 'png', 'rect', 'cursor', 'copy', 'cfill']);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  const token = await getToken();
  console.log('token len=', token ? token.length : 0, 'cid=', CID);

  const qs = new URLSearchParams({
    token, GUAC_DATA_SOURCE: 'postgresql', GUAC_ID: CID, GUAC_TYPE: 'c',
    GUAC_WIDTH: '1280', GUAC_HEIGHT: '720', GUAC_DPI: '96', GUAC_TIMEZONE: 'UTC',
    GUAC_AUDIO: 'audio/L16', GUAC_IMAGE: 'image/png',
  });
  const ws = new WebSocket(`${GUAC_WS}?${qs.toString()}`, ['guacamole']);

  let active = false;
  let drawCount = 0;     // running counter of drawing ops
  let errored = null;

  const parse = makeParser((e) => {
    const op = e[0];
    if (DRAW_OPS.has(op)) { drawCount++; active = true; }
    if (op === 'args') {
      const argNames = e.slice(1);
      ws.send(instr('size', '1280', '720', '96'));
      ws.send(instr('audio', 'audio/L16'));
      ws.send(instr('video'));
      ws.send(instr('image', 'image/png'));
      ws.send(instr('timezone', 'UTC'));
      ws.send(instr('connect', ...argNames.map(() => '')));
    } else if (op === 'error') {
      errored = e.slice(1).join(' | ');
    }
  });
  ws.addEventListener('message', (ev) => parse(ev.data));
  ws.addEventListener('error', () => {});
  ws.addEventListener('close', (ev) => { if (!errored) errored = `closed ${ev.code} ${ev.reason || ''}`; });

  // Wait up to 12s for the live desktop.
  const t0 = Date.now();
  while (!active && Date.now() - t0 < 12000 && !errored) await sleep(200);
  if (!active) { console.log('NO DESKTOP. error=', errored); try { ws.close(); } catch {} return; }

  // Let it settle, then measure an IDLE baseline (no input) for 2.5s.
  await sleep(1500);
  let base = drawCount;
  await sleep(2500);
  const idleDelta = drawCount - base;

  // Mouse-move sanity: jiggle the cursor (proves the input channel is open
  // at all). mouse,<x>,<y>,<buttonmask>
  ws.send(instr('mouse', '640', '360', '0'));
  ws.send(instr('mouse', '650', '370', '0'));
  await sleep(800);
  const afterMouse = drawCount;

  // KEY TEST: press + release Super_L (Windows key) -> Start menu must open.
  // keysym Super_L = 0xFFEB = 65515. key,<keysym>,<pressed>
  base = drawCount;
  ws.send(instr('key', '65515', '1'));
  await sleep(80);
  ws.send(instr('key', '65515', '0'));
  await sleep(2500);
  const keyDelta = drawCount - base;

  // Close the menu we (hopefully) opened: Escape = 0xFF1B = 65307.
  ws.send(instr('key', '65307', '1'));
  await sleep(60);
  ws.send(instr('key', '65307', '0'));

  console.log(`idle drawing ops (2.5s):       ${idleDelta}`);
  console.log(`after Windows-key (2.5s):      ${keyDelta}`);
  const verdict = keyDelta > idleDelta + 2
    ? 'PASS - Windows key produced a screen change => KEYBOARD WORKS server-side (issue is client/browser focus)'
    : 'FAIL - Windows key produced NO extra screen change => keystrokes are NOT registering at the RDP server';
  console.log('VERDICT:', verdict);

  try { ws.close(); } catch {}
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
