// Integration tests: the real gate (startApp) in front of the fake Obscura
// server, which enforces Obscura's Host, Origin and bearer-token checks.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startApp } from '../src/app.js';
import { createFakeObscura } from './fake-obscura.js';
import { INTERNAL_TOKEN, TOKEN, captureLog, delay, freePort, request, stubSpawn, wsConnect } from './helpers.js';

const bearer = { authorization: `Bearer ${TOKEN}` };
const publicHeaders = { host: 'obscura.up.railway.app', 'x-forwarded-proto': 'https' };

async function startGate(fake, extraEnv = {}) {
  const internalPort = await fake.listen();
  const port = await freePort();
  const { log, lines } = captureLog();
  const app = await startApp(
    { OBSCURA_TOKEN: TOKEN, PORT: String(port), OBSCURA_INTERNAL_PORT: String(internalPort), ...extraEnv },
    { log, spawnImpl: stubSpawn(), internalToken: INTERNAL_TOKEN },
  );
  return { app, port, lines };
}

describe('gate in front of fake Obscura', () => {
  const fake = createFakeObscura({ token: INTERNAL_TOKEN });
  let gate;

  before(async () => {
    gate = await startGate(fake);
  });
  after(async () => {
    await gate.app.stop();
    await fake.close();
  });

  test('health and robots are public; health reflects Obscura', async () => {
    const health = await request(gate.port, { path: '/health' });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { status: 'ok' });
    assert.equal((await request(gate.port, { path: '/health', method: 'HEAD' })).status, 200);
    assert.equal((await request(gate.port, { path: '/robots.txt' })).text, 'User-agent: *\nDisallow: /\n');
    assert.equal((await request(gate.port, { path: '/health', method: 'POST' })).status, 405);
  });

  test('everything else needs the public token; the internal one does not work from outside', async () => {
    for (const path of ['/', '/json/version', '/json/list', `/json/version?token=wrong-${TOKEN}`]) {
      const res = await request(gate.port, { path });
      assert.equal(res.status, 401, path);
      assert.equal(res.json.error, 'unauthorized');
      assert.equal(res.headers['www-authenticate'], undefined);
    }
    assert.equal((await request(gate.port, { path: '/json/version', headers: { authorization: 'Bearer nope' } })).status, 401);
    const internal = await request(gate.port, { path: '/json/version', headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
    assert.equal(internal.status, 401);
  });

  test('token accepted as query, Bearer and Basic', async () => {
    const basic = `Basic ${Buffer.from(`obscura:${TOKEN}`).toString('base64')}`;
    assert.equal((await request(gate.port, { path: `/json/version?token=${TOKEN}` })).status, 200);
    assert.equal((await request(gate.port, { path: '/json/version', headers: bearer })).status, 200);
    assert.equal((await request(gate.port, { path: '/json/version', headers: { authorization: basic } })).status, 200);
  });

  test('upstream sees loopback Host, the internal token, no public token, no Origin', async () => {
    fake.requests.length = 0;
    const res = await request(gate.port, {
      path: `/json/version?a=1&token=${TOKEN}`,
      headers: { ...publicHeaders, origin: 'https://obscura.up.railway.app' },
    });
    assert.equal(res.status, 200);
    const seen = fake.requests.at(-1);
    assert.equal(seen.url, '/json/version?a=1');
    assert.match(seen.headers.host, /^127\.0\.0\.1:\d+$/);
    assert.equal(seen.headers.authorization, `Bearer ${INTERNAL_TOKEN}`);
    assert.equal(seen.headers.origin, undefined);
    assert.ok(!JSON.stringify(seen).includes(TOKEN));
  });

  test('cross-site Origin is refused before auth', async () => {
    const res = await request(gate.port, {
      path: `/json/version?token=${TOKEN}`,
      headers: { ...publicHeaders, origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'origin_not_allowed');
  });

  test('/json/version advertises the public wss URL with the token', async () => {
    const res = await request(gate.port, { path: `/json/version/?token=${TOKEN}`, headers: publicHeaders });
    assert.equal(res.status, 200);
    assert.equal(res.json.webSocketDebuggerUrl, `wss://obscura.up.railway.app/devtools/browser?token=${TOKEN}`);
    assert.equal(res.json.Browser, 'Chrome/145.0.0.0');
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.text)));
    assert.ok(!res.text.includes(INTERNAL_TOKEN));
  });

  test('private network clients get ws:// with their host and port', async () => {
    const res = await request(gate.port, {
      path: '/json/version',
      headers: { host: 'obscura.railway.internal:8080', ...bearer },
    });
    assert.equal(res.json.webSocketDebuggerUrl, `ws://obscura.railway.internal:8080/devtools/browser?token=${TOKEN}`);
  });

  test('/json/list is rewritten; /json/protocol passes through', async () => {
    const list = await request(gate.port, { path: `/json/list?token=${TOKEN}`, headers: publicHeaders });
    assert.equal(list.json[0].webSocketDebuggerUrl, `wss://obscura.up.railway.app/devtools/page/page-1?token=${TOKEN}`);
    const bare = await request(gate.port, { path: `/json?token=${TOKEN}`, headers: publicHeaders });
    assert.equal(bare.json[0].id, 'page-1');
    const protocol = await request(gate.port, { path: '/json/protocol', headers: bearer });
    assert.deepEqual(protocol.json, { version: { major: '1', minor: '3' } });
  });

  test('other HTTP paths and methods are answered by the gate', async () => {
    const missing = await request(gate.port, { path: '/json/new?about:blank', headers: bearer });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'not_found');
    assert.equal((await request(gate.port, { path: '/devtools/browser', headers: bearer })).status, 404);
    assert.equal((await request(gate.port, { method: 'PUT', path: '/json/version', headers: bearer })).status, 405);
  });

  test('authorized GET / shows connection info without any token', async () => {
    const res = await request(gate.port, { path: '/', headers: { ...publicHeaders, ...bearer } });
    assert.equal(res.status, 200);
    assert.equal(res.json.service, 'obscura-gate');
    assert.equal(res.json.obscura.stealth, false);
    assert.equal(res.json.obscura.workers, 1);
    assert.equal(res.json.connect.cdp, 'wss://obscura.up.railway.app?token={OBSCURA_TOKEN}');
    assert.ok(!res.text.includes(TOKEN));
    assert.ok(!res.text.includes(INTERNAL_TOKEN));
  });

  test('root WebSocket maps to the browser endpoint (Browserless-style URL)', async () => {
    fake.requests.length = 0;
    const ws = await wsConnect(gate.port, `/?token=${TOKEN}`, publicHeaders);
    assert.equal(ws.status, 101);
    const upstream = fake.requests.find((r) => r.upgrade);
    assert.equal(upstream.url, '/devtools/browser');
    assert.match(upstream.headers.host, /^127\.0\.0\.1:\d+$/);
    assert.equal(upstream.headers.authorization, `Bearer ${INTERNAL_TOKEN}`);
    ws.send('{"id":1,"method":"Browser.getVersion"}');
    assert.equal(await ws.next(), '{"id":1,"method":"Browser.getVersion"}');
    const big = 'y'.repeat(5000);
    ws.send(big);
    assert.equal(await ws.next(), big);
    ws.socket.destroy();
  });

  test('page and browser WebSocket paths; Bearer on the upgrade', async () => {
    for (const path of ['/devtools/page/page-1', '/devtools/browser', '/devtools/browser/']) {
      fake.requests.length = 0;
      const ws = await wsConnect(gate.port, path, bearer);
      assert.equal(ws.status, 101, path);
      assert.equal(fake.requests.find((r) => r.upgrade).url, path === '/devtools/page/page-1' ? path : '/devtools/browser');
      ws.socket.destroy();
    }
  });

  test('WebSocket without token or with a wrong Origin', async () => {
    const noToken = await wsConnect(gate.port, '/');
    assert.equal(noToken.status, 401);
    const evil = await wsConnect(gate.port, `/?token=${TOKEN}`, { ...publicHeaders, origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const sameSite = await wsConnect(gate.port, `/?token=${TOKEN}`, { ...publicHeaders, origin: 'https://obscura.up.railway.app' });
    assert.equal(sameSite.status, 101);
    sameSite.socket.destroy();
  });

  test('non-WebSocket upgrade is refused', async () => {
    const res = await wsConnect(gate.port, `/?token=${TOKEN}`, { upgrade: 'h2c' });
    assert.equal(res.status, 400);
  });

  test('session count drops back after clients disconnect', async () => {
    await delay(50);
    assert.equal(gate.app.sessions.active, 0);
    assert.ok(gate.lines.some((l) => l.message === 'session closed'));
    const logged = JSON.stringify(gate.lines);
    assert.ok(!logged.includes(TOKEN));
    assert.ok(!logged.includes(INTERNAL_TOKEN));
  });
});

describe('limits and timeouts', () => {
  test('OBSCURA_MAX_SESSIONS refuses extra WebSockets with 429', async () => {
    const fake = createFakeObscura({ token: INTERNAL_TOKEN });
    const gate = await startGate(fake, { OBSCURA_MAX_SESSIONS: '1' });
    try {
      const first = await wsConnect(gate.port, '/', bearer);
      assert.equal(first.status, 101);
      const second = await wsConnect(gate.port, '/', bearer);
      assert.equal(second.status, 429);
      assert.equal(second.headers['retry-after'], '5');
      first.socket.destroy();
      await delay(50);
      const third = await wsConnect(gate.port, '/', bearer);
      assert.equal(third.status, 101);
      third.socket.destroy();
    } finally {
      await gate.app.stop();
      await fake.close();
    }
  });

  test('idle and session timeouts close the socket', async () => {
    const fake = createFakeObscura({ token: INTERNAL_TOKEN });
    const gate = await startGate(fake, { OBSCURA_IDLE_TIMEOUT: '1' });
    try {
      const ws = await wsConnect(gate.port, '/', bearer);
      const started = Date.now();
      await ws.closed();
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 900 && elapsed < 3000, `closed after ${elapsed} ms`);
      assert.ok(gate.lines.some((l) => l.fields?.reason === 'idle_timeout'));
    } finally {
      await gate.app.stop();
      await fake.close();
    }
    const fake2 = createFakeObscura({ token: INTERNAL_TOKEN });
    const gate2 = await startGate(fake2, { OBSCURA_IDLE_TIMEOUT: '0', OBSCURA_SESSION_TIMEOUT: '1' });
    try {
      const ws = await wsConnect(gate2.port, '/', bearer);
      const keepBusy = setInterval(() => ws.send('ping'), 100);
      await ws.closed();
      clearInterval(keepBusy);
      assert.ok(gate2.lines.some((l) => l.fields?.reason === 'session_timeout'));
    } finally {
      await gate2.app.stop();
      await fake2.close();
    }
  });

  test('wrong internal token: health 503 (Obscura answers 401)', async () => {
    const fake = createFakeObscura({ token: 'a-different-internal-token-0123456789abcdef' });
    const gate = await startGate(fake);
    try {
      assert.equal((await request(gate.port, { path: '/health' })).status, 503);
    } finally {
      await gate.app.stop();
      await fake.close();
    }
  });

  test('Obscura down: health 503, requests 502, upgrades 502', async () => {
    const fake = createFakeObscura({ token: INTERNAL_TOKEN });
    const gate = await startGate(fake);
    await fake.close();
    try {
      await delay(2100);
      assert.equal((await request(gate.port, { path: '/health' })).status, 503);
      const res = await request(gate.port, { path: '/json/version', headers: bearer });
      assert.equal(res.status, 502);
      assert.equal(res.json.error, 'obscura_unavailable');
      assert.equal((await wsConnect(gate.port, '/', bearer)).status, 502);
      assert.equal((await wsConnect(gate.port, '/devtools/page/page-1', bearer)).status, 502);
      assert.equal(gate.app.sessions.active, 0);
    } finally {
      await gate.app.stop();
    }
  });

  test('slow Obscura responses hit OBSCURA_HTTP_TIMEOUT with 504', async () => {
    const fake = createFakeObscura({ token: INTERNAL_TOKEN });
    const gate = await startGate(fake, { OBSCURA_HTTP_TIMEOUT: '1' });
    fake.slowMs = 2000;
    try {
      const res = await request(gate.port, { path: '/json/protocol', headers: bearer });
      assert.equal(res.status, 504);
      assert.equal(res.json.error, 'obscura_timeout');
    } finally {
      await gate.app.stop();
      await fake.close();
    }
  });

  test('shutdown closes open sessions', async () => {
    const fake = createFakeObscura({ token: INTERNAL_TOKEN });
    const gate = await startGate(fake);
    const ws = await wsConnect(gate.port, '/', bearer);
    await gate.app.stop();
    await ws.closed();
    assert.equal(gate.app.sessions.active, 0);
    await fake.close();
  });
});
