import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig, parseBool, parseInteger } from '../src/config.js';

const TOKEN = 'abcdefghijklmnop0123456789';

test('defaults: no stealth, one worker, private networks blocked, 10 sessions, 30 min idle', () => {
  const config = loadConfig({ OBSCURA_TOKEN: TOKEN });
  assert.equal(config.port, 8080);
  assert.equal(config.internalHost, '127.0.0.1');
  assert.equal(config.internalPort, 9222);
  assert.equal(config.stealth, false);
  assert.equal(config.workers, 1);
  assert.equal(config.blockPrivateNetworks, true);
  assert.equal(config.maxSessions, 10);
  assert.equal(config.idleTimeoutMs, 1_800_000);
  assert.equal(config.sessionTimeoutMs, 0);
  assert.equal(config.httpTimeoutMs, 600_000);
  assert.equal(config.obscuraLogLevel, 'warn');
  assert.equal(config.obscuraBin, '/usr/local/bin/obscura');
  assert.deepEqual(config.extraArgs, []);
  assert.deepEqual(config.allowedOrigins, []);
  assert.ok(Object.isFrozen(config));
});

test('internal token: random, 64 hex characters, different from the public token', () => {
  const a = loadConfig({ OBSCURA_TOKEN: TOKEN });
  const b = loadConfig({ OBSCURA_TOKEN: TOKEN });
  assert.match(a.internalToken, /^[0-9a-f]{64}$/);
  assert.notEqual(a.internalToken, b.internalToken);
  assert.notEqual(a.internalToken, TOKEN);
  assert.equal(loadConfig({ OBSCURA_TOKEN: TOKEN }, { internalToken: 'x'.repeat(40) }).internalToken, 'x'.repeat(40));
});

test('token is required, URL-safe and at least 16 characters', () => {
  assert.throws(() => loadConfig({}), /OBSCURA_TOKEN is empty/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: '   ' }), /OBSCURA_TOKEN is empty/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: 'short' }), /16-512 characters/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: 'has spaces in the token ok?' }), /16-512/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: 'abc/def+ghi=jklmnop' }), /16-512/);
  assert.equal(loadConfig({ OBSCURA_TOKEN: ` ${TOKEN} ` }).token, TOKEN);
});

test('port validation', () => {
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, PORT: '9222' }), /must differ/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, PORT: '0' }), /between 1 and 65535/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, PORT: '80a' }), /whole number/);
  assert.equal(loadConfig({ OBSCURA_TOKEN: TOKEN, PORT: '3000' }).port, 3000);
});

test('numeric limits, workers and timeouts', () => {
  const c = loadConfig({
    OBSCURA_TOKEN: TOKEN,
    OBSCURA_WORKERS: '4',
    OBSCURA_MAX_SESSIONS: '0',
    OBSCURA_SESSION_TIMEOUT: '600',
    OBSCURA_IDLE_TIMEOUT: '0',
    OBSCURA_HTTP_TIMEOUT: '30',
  });
  assert.equal(c.workers, 4);
  assert.equal(c.maxSessions, 0);
  assert.equal(c.sessionTimeoutMs, 600_000);
  assert.equal(c.idleTimeoutMs, 0);
  assert.equal(c.httpTimeoutMs, 30_000);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_WORKERS: '0' }), /between 1 and 32/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_MAX_SESSIONS: '-1' }), /whole number/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_HTTP_TIMEOUT: '0' }), /between 1 and 3600/);
});

test('booleans accept common spellings and reject others', () => {
  assert.equal(parseBool({ X: 'YES' }, 'X', false), true);
  assert.equal(parseBool({ X: 'off' }, 'X', true), false);
  assert.equal(parseBool({ X: '' }, 'X', true), true);
  assert.equal(parseBool({}, 'X', false), false);
  assert.throws(() => parseBool({ X: 'enabled' }, 'X', true), /true or false/);
  assert.equal(loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_BLOCK_PRIVATE_NETWORKS: 'false' }).blockPrivateNetworks, false);
  assert.equal(loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_STEALTH: 'true' }).stealth, true);
});

test('parseInteger fallback and range', () => {
  assert.equal(parseInteger({}, 'N', { fallback: 5, min: 0, max: 10 }), 5);
  assert.throws(() => parseInteger({ N: '11' }, 'N', { fallback: 5, min: 0, max: 10 }), ConfigError);
});

test('log levels are validated', () => {
  assert.equal(loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_LOG_LEVEL: 'INFO' }).obscuraLogLevel, 'info');
  assert.equal(loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_LOG_LEVEL: 'trace' }).obscuraLogLevel, 'trace');
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_LOG_LEVEL: 'fatal' }), /OBSCURA_LOG_LEVEL/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_GATE_LOG_LEVEL: 'trace' }), /OBSCURA_GATE_LOG_LEVEL/);
});

test('extra args are split and reserved flags are refused', () => {
  const c = loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_EXTRA_ARGS: `--user-agent "Agent 1.0" --proxy 'socks5://p:1080'` });
  assert.deepEqual(c.extraArgs, ['--user-agent', 'Agent 1.0', '--proxy', 'socks5://p:1080']);
  for (const bad of ['--host 0.0.0.0', '--port=1', '-p 1', '-p9000', '--ready-file /tmp/x']) {
    assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_EXTRA_ARGS: bad }), /must not set/, bad);
  }
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_EXTRA_ARGS: 'fetch https://x' }), /only flags/);
  assert.throws(() => loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_EXTRA_ARGS: '--user-agent "oops' }), /unterminated/);
  // -P is not -p (port).
  assert.deepEqual(loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_EXTRA_ARGS: '-P x' }).extraArgs, ['-P', 'x']);
});

test('allowed origins are normalized', () => {
  const c = loadConfig({ OBSCURA_TOKEN: TOKEN, OBSCURA_ALLOWED_ORIGINS: ' https://App.Example.com/ , ,http://localhost:3000' });
  assert.deepEqual(c.allowedOrigins, ['https://app.example.com', 'http://localhost:3000']);
});
