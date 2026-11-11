import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  downstreamResponseHeaders,
  isWebSocketUpgrade,
  upgradeRequestHead,
  upstreamRequestHeaders,
} from '../src/headers.js';
import { createLogger, createRateLimitedCounter } from '../src/log.js';
import {
  appendToken,
  clientOrigin,
  isValidHost,
  rewriteBody,
  rewriteJson,
  rewriteWsUrl,
  shouldRewrite,
} from '../src/rewrite.js';
import { createSessionRegistry } from '../src/sessions.js';

const TOKEN = 'abcdefghijklmnop0123456789';
const ctx = (secure, host = 'obscura.up.railway.app') => ({
  prefixes: ['ws://127.0.0.1:9222', 'ws://localhost:9222'],
  secure,
  host,
  token: TOKEN,
});

test('which responses are rewritten', () => {
  for (const path of ['/json', '/json/list', '/json/version/', '/json/version']) assert.equal(shouldRewrite(path), true);
  assert.equal(shouldRewrite('/json/protocol'), false);
  assert.equal(shouldRewrite('/devtools/browser'), false);
});

test('client origin from X-Forwarded-Proto and Host', () => {
  const opts = { fallbackHost: 'fb', publicDomain: 'browser.example.com' };
  assert.deepEqual(clientOrigin({ host: 'obscura.up.railway.app', 'x-forwarded-proto': 'https' }, opts), {
    secure: true,
    host: 'obscura.up.railway.app',
  });
  assert.deepEqual(clientOrigin({ host: 'obscura.railway.internal:8080' }, opts), {
    secure: false,
    host: 'obscura.railway.internal:8080',
  });
  assert.deepEqual(clientOrigin({ host: 'bad host/x', 'x-forwarded-proto': 'HTTPS, http' }, { fallbackHost: 'fb:1' }), {
    secure: true,
    host: 'fb:1',
  });
  // The Railway domain (and the configured public domain) is HTTPS-only even
  // if the edge did not send X-Forwarded-Proto.
  assert.equal(clientOrigin({ host: 'obscura-production-1234.up.railway.app' }, opts).secure, true);
  assert.equal(clientOrigin({ host: 'Browser.Example.com' }, opts).secure, true);
  assert.equal(clientOrigin({ host: 'other.example.com' }, opts).secure, false);
  assert.equal(isValidHost('[fd12::1]:8080'), true);
  assert.equal(isValidHost('a@b'), false);
});

test('ws URLs are rewritten to the public address with the token', () => {
  assert.equal(
    rewriteWsUrl('ws://127.0.0.1:9222/devtools/browser/abc', ctx(true)),
    `wss://obscura.up.railway.app/devtools/browser/abc?token=${TOKEN}`,
  );
  assert.equal(
    rewriteWsUrl('ws://localhost:9222/devtools/page/page-1', ctx(false, 'obscura.railway.internal:8080')),
    `ws://obscura.railway.internal:8080/devtools/page/page-1?token=${TOKEN}`,
  );
  assert.equal(rewriteWsUrl('ws://127.0.0.1:9222', ctx(true)), `wss://obscura.up.railway.app/?token=${TOKEN}`);
  assert.equal(rewriteWsUrl('ws://127.0.0.1:92220/x', ctx(true)), null);
  assert.equal(rewriteWsUrl('https://example.com/ws://127.0.0.1:9222/', ctx(true)), null);
  assert.equal(appendToken('wss://h/p?a=1', 'x y'), 'wss://h/p?a=1&token=x%20y');
});

test('rewriteJson walks objects and arrays without mutating the input', () => {
  const input = [
    {
      id: 'P1',
      url: 'ws://127.0.0.1:9222/not-a-target-but-internal',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/P1',
      devtoolsFrontendUrl: '',
      nested: { list: ['ws://127.0.0.1:9222/session/S1', 7, null, true] },
    },
  ];
  const copy = structuredClone(input);
  const out = rewriteJson(input, ctx(true));
  assert.deepEqual(input, copy);
  assert.equal(out[0].webSocketDebuggerUrl, `wss://obscura.up.railway.app/devtools/page/P1?token=${TOKEN}`);
  assert.equal(out[0].nested.list[0], `wss://obscura.up.railway.app/session/S1?token=${TOKEN}`);
  assert.deepEqual(out[0].nested.list.slice(1), [7, null, true]);
  assert.equal(out[0].devtoolsFrontendUrl, '');
});

test('rewriteBody leaves non-JSON alone', () => {
  assert.equal(rewriteBody(Buffer.from('<html>'), ctx(true)), null);
  const body = rewriteBody(Buffer.from('{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/x"}'), ctx(true));
  assert.equal(JSON.parse(body.toString()).webSocketDebuggerUrl, `wss://obscura.up.railway.app/devtools/browser/x?token=${TOKEN}`);
});

test('upstream request headers: loopback Host, internal token, no Origin, no hop-by-hop', () => {
  const out = upstreamRequestHeaders(
    {
      host: 'obscura.up.railway.app',
      origin: 'https://obscura.up.railway.app',
      authorization: `Bearer ${TOKEN}`,
      connection: 'keep-alive, x-drop-me',
      'x-drop-me': '1',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      'x-forwarded-for': '1.2.3.4',
      expect: '100-continue',
      'content-type': 'application/json',
      'accept-encoding': 'gzip',
      cookie: 'a=b',
    },
    { host: '127.0.0.1:9222', authorization: 'Bearer internal', identityEncoding: true },
  );
  assert.deepEqual(out, {
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    cookie: 'a=b',
    host: '127.0.0.1:9222',
    authorization: 'Bearer internal',
  });
  const plain = upstreamRequestHeaders(
    { 'accept-encoding': 'gzip' },
    { host: 'h', authorization: 'Bearer i', identityEncoding: false },
  );
  assert.equal(plain['accept-encoding'], 'gzip');
});

test('downstream response headers drop hop-by-hop', () => {
  assert.deepEqual(
    downstreamResponseHeaders(
      { 'content-type': 'x', connection: 'close', 'transfer-encoding': 'chunked', 'content-length': '5' },
      { 'content-length': '9' },
    ),
    { 'content-type': 'x', 'content-length': '9' },
  );
});

test('upgrade request head keeps WebSocket headers, replaces Host and credentials', () => {
  const head = upgradeRequestHead(
    [
      'Host', 'obscura.up.railway.app',
      'Upgrade', 'websocket',
      'Connection', 'Upgrade',
      'Sec-WebSocket-Key', 'abc==',
      'Sec-WebSocket-Version', '13',
      'Origin', 'https://obscura.up.railway.app',
      'Authorization', `Bearer ${TOKEN}`,
      'X-Forwarded-Proto', 'https',
      'User-Agent', 'Playwright',
    ],
    '/devtools/browser',
    { host: '127.0.0.1:9222', authorization: 'Bearer internal' },
  );
  assert.equal(
    head,
    'GET /devtools/browser HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nAuthorization: Bearer internal\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: abc==\r\nSec-WebSocket-Version: 13\r\nUser-Agent: Playwright\r\n\r\n',
  );
  assert.ok(!head.includes(TOKEN));
});

test('isWebSocketUpgrade', () => {
  const req = (method, headers) => ({ method, headers });
  assert.equal(isWebSocketUpgrade(req('GET', { upgrade: 'WebSocket', connection: 'keep-alive, Upgrade' })), true);
  assert.equal(isWebSocketUpgrade(req('GET', { upgrade: 'h2c', connection: 'Upgrade' })), false);
  assert.equal(isWebSocketUpgrade(req('POST', { upgrade: 'websocket', connection: 'Upgrade' })), false);
  assert.equal(isWebSocketUpgrade(req('GET', { upgrade: 'websocket' })), false);
});

test('session registry enforces the limit and closes all', () => {
  const sessions = createSessionRegistry({ max: 2 });
  const a = sessions.tryAcquire();
  const b = sessions.tryAcquire();
  assert.equal(sessions.tryAcquire(), null);
  assert.equal(sessions.active, 2);
  a.release();
  a.release();
  assert.equal(sessions.active, 1);
  let closed = 0;
  b.attach(() => {
    closed += 1;
    b.release();
  });
  sessions.closeAll();
  assert.equal(closed, 1);
  assert.equal(sessions.active, 0);
  const unlimited = createSessionRegistry({ max: 0 });
  for (let i = 0; i < 50; i += 1) assert.notEqual(unlimited.tryAcquire(), null);
});

test('logger levels, fields and rate-limited counter', () => {
  const lines = [];
  const log = createLogger({ level: 'info', write: (level, line) => lines.push([level, line]) });
  log.debug('hidden');
  log.info('hello', { a: 1, b: 'two words', c: undefined, d: '' });
  log.error('bad');
  assert.deepEqual(lines, [
    ['info', '[obscura-gate] INFO hello a=1 b="two words"'],
    ['error', '[obscura-gate] ERROR bad'],
  ]);
  const counter = createRateLimitedCounter({ log, intervalMs: 10_000, message: 'refused' });
  counter.record({ client: '1.1.1.1' });
  counter.record({ client: '2.2.2.2' });
  counter.flush();
  counter.flush();
  assert.deepEqual(lines[2], ['warn', '[obscura-gate] WARN refused count=2 client=2.2.2.2']);
  assert.equal(lines.length, 3);
});
