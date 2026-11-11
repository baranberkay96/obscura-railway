// End to end: `node src/main.js` as in the image, with test/fake-obscura.js
// as the Obscura binary. Covers startup, the internal token handover,
// readiness, a CDP WebSocket through the root URL, an Obscura crash and
// restart (the internal token lives as long as the gate, so the new process
// gets the same one),
// and SIGTERM.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TOKEN, delay, freePort, request, wsConnect } from './helpers.js';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const FAKE_OBSCURA = fileURLToPath(new URL('./fake-obscura.js', import.meta.url));

function run(env) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (c) => output.push(c.toString()));
  child.stderr.on('data', (c) => output.push(c.toString()));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, output, exited };
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not ready yet
    }
    await delay(100);
  }
  throw new Error('condition not met in time');
}

test('main.js supervises Obscura and proxies CDP end to end', async () => {
  chmodSync(FAKE_OBSCURA, 0o755);
  const port = await freePort();
  const internalPort = await freePort();
  const gate = run({
    OBSCURA_TOKEN: TOKEN,
    PORT: String(port),
    OBSCURA_INTERNAL_PORT: String(internalPort),
    OBSCURA_BIN: FAKE_OBSCURA,
    OBSCURA_STEALTH: 'true',
    OBSCURA_TIMEZONE: 'UTC',
    OBSCURA_EXTRA_ARGS: '--user-agent "E2E Agent" --proxy http://user:secret@proxy:3128',
    RAILWAY_PUBLIC_DOMAIN: 'obscura.up.railway.app',
  });
  const obscuraPids = [];
  try {
    await waitFor(async () => (await request(port, { path: '/health' })).status === 200);
    const logs = gate.output.join('');
    assert.match(
      logs,
      /fake obscura listening on 127\.0\.0\.1:\d+ args=serve --host 127\.0\.0\.1 --port \d+ --stealth --user-agent E2E Agent --proxy http:\/\/user:secret@proxy:3128 env=OBSCURA_CDP_TOKEN,OBSCURA_TIMEZONE\n/,
    );
    assert.match(logs, /starting obscura .*--proxy \*\*\*/);
    assert.ok(!logs.includes(TOKEN), 'token must not be logged');
    const gateLines = logs.split('\n').filter((line) => line.startsWith('[obscura-gate]'));
    assert.ok(!gateLines.join('\n').includes('secret'), 'proxy credentials must not be logged by the gate');

    const version = await request(port, {
      path: `/json/version?token=${TOKEN}`,
      headers: { host: 'obscura.up.railway.app', 'x-forwarded-proto': 'https' },
    });
    assert.equal(version.json.webSocketDebuggerUrl, `wss://obscura.up.railway.app/devtools/browser?token=${TOKEN}`);
    const ws = await wsConnect(port, `/?token=${TOKEN}`);
    assert.equal(ws.status, 101);
    ws.send('hello');
    assert.equal(await ws.next(), 'hello');

    const info = await request(port, { path: '/', headers: { authorization: `Bearer ${TOKEN}` } });
    const pid = info.json.obscura.pid;
    obscuraPids.push(pid);
    assert.equal(info.json.obscura.status, 'running');
    assert.equal(info.json.obscura.stealth, true);
    process.kill(pid, 'SIGKILL');
    await ws.closed();
    await waitFor(async () => {
      const again = await request(port, { path: '/', headers: { authorization: `Bearer ${TOKEN}` } });
      obscuraPids.push(again.json.obscura.pid);
      return again.json.obscura.status === 'running' && again.json.obscura.pid !== pid;
    });
    // /health is cached for 2 s; wait for a real answer from the new process.
    await waitFor(
      async () =>
        (await request(port, { path: '/json/version', headers: { authorization: `Bearer ${TOKEN}` } })).status === 200,
    );
    const ws2 = await wsConnect(port, '/', { authorization: `Bearer ${TOKEN}` });
    assert.equal(ws2.status, 101);
    ws2.socket.destroy();

    gate.child.kill('SIGTERM');
    const { code } = await gate.exited;
    assert.equal(code, 0);
    assert.match(gate.output.join(''), /shutting down/);
    for (const obscuraPid of new Set(obscuraPids.filter(Boolean))) {
      assert.throws(() => process.kill(obscuraPid, 0), /ESRCH/, `obscura ${obscuraPid} must be stopped with the gate`);
    }
  } finally {
    gate.child.kill('SIGKILL');
    for (const pid of obscuraPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

test('main.js refuses to start without a valid token', async () => {
  const gate = run({ PORT: String(await freePort()), OBSCURA_BIN: FAKE_OBSCURA });
  const { code } = await gate.exited;
  assert.equal(code, 1);
  assert.match(gate.output.join(''), /configuration error: OBSCURA_TOKEN is empty/);
});

test('main.js exits when the Obscura binary is missing', async () => {
  const gate = run({ OBSCURA_TOKEN: TOKEN, PORT: String(await freePort()), OBSCURA_BIN: '/nonexistent/obscura' });
  const { code } = await gate.exited;
  assert.equal(code, 1);
  assert.match(gate.output.join(''), /giving up on obscura .*ENOENT/);
});
