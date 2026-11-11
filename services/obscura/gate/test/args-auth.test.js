import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildObscuraArgs, buildObscuraEnv, redactArgs, splitArgs } from '../src/args.js';
import {
  createTokenMatcher,
  isAuthorized,
  isOriginAllowed,
  splitTarget,
  stripTokenFromQuery,
  tokenFromAuthorization,
  tokenFromQuery,
} from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'abcdefghijklmnop0123456789';
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('splitArgs handles quotes and escapes', () => {
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('  --a  b\t--c '), ['--a', 'b', '--c']);
  assert.deepEqual(splitArgs(`--ua "a \\"b\\" c" --x 'single $HOME' --y a\\ b`), [
    '--ua',
    'a "b" c',
    '--x',
    'single $HOME',
    '--y',
    'a b',
  ]);
  assert.deepEqual(splitArgs(`--empty ""`), ['--empty', '']);
  assert.throws(() => splitArgs(`'open`), /unterminated ' quote/);
});

test('buildObscuraArgs adds switches once', () => {
  const base = ['serve', '--host', '127.0.0.1', '--port', '9222'];
  assert.deepEqual(buildObscuraArgs(loadConfig({ OBSCURA_TOKEN: TOKEN })), base);
  assert.deepEqual(
    buildObscuraArgs(
      loadConfig({
        OBSCURA_TOKEN: TOKEN,
        OBSCURA_STEALTH: 'true',
        OBSCURA_WORKERS: '3',
        OBSCURA_BLOCK_PRIVATE_NETWORKS: 'false',
      }),
    ),
    [...base, '--stealth', '--workers', '3', '--allow-private-network'],
  );
  assert.deepEqual(
    buildObscuraArgs(
      loadConfig({
        OBSCURA_TOKEN: TOKEN,
        OBSCURA_STEALTH: 'true',
        OBSCURA_WORKERS: '3',
        OBSCURA_EXTRA_ARGS: '--stealth --workers=2 --worker-max-rss 400',
      }),
    ),
    [...base, '--stealth', '--workers=2', '--worker-max-rss', '400'],
  );
});

test('buildObscuraEnv: allowlist plus Obscura tuning, internal token only', () => {
  const config = loadConfig({ OBSCURA_TOKEN: TOKEN }, { internalToken: 'i'.repeat(64) });
  const env = buildObscuraEnv(
    {
      OBSCURA_TOKEN: TOKEN,
      OBSCURA_STEALTH: 'true',
      OBSCURA_CDP_TOKEN: 'user-supplied-value-that-must-not-win-0000',
      OBSCURA_ALLOW_PRIVATE_NETWORK: '1',
      OBSCURA_MCP_TOKEN: 'x'.repeat(40),
      OBSCURA_TIMEZONE: 'America/New_York',
      OBSCURA_PROXY: '',
      OBSCURA_NAV_TIMEOUT_MS: '60000',
      BROWSER_WS_ENDPOINT: `wss://x?token=${TOKEN}`,
      PATH: '/usr/bin',
      HOME: '/home/obscura',
      HTTPS_PROXY: '',
      RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app',
    },
    config,
  );
  assert.deepEqual(env, {
    NO_COLOR: '1',
    RUST_LOG: 'warn',
    OBSCURA_TIMEZONE: 'America/New_York',
    OBSCURA_NAV_TIMEOUT_MS: '60000',
    PATH: '/usr/bin',
    HOME: '/home/obscura',
    OBSCURA_CDP_TOKEN: 'i'.repeat(64),
  });
  assert.equal(buildObscuraEnv({ RUST_LOG: 'obscura=debug' }, config).RUST_LOG, 'obscura=debug');
});

test('redactArgs hides proxy credentials', () => {
  assert.deepEqual(redactArgs(['serve', '--proxy', 'http://u:p@proxy:8080', '--stealth', '--proxy=socks5://a:b@h:1']), [
    'serve',
    '--proxy',
    '***',
    '--stealth',
    '--proxy=***',
  ]);
});

test('splitTarget and token query handling keep other parameters byte for byte', () => {
  assert.deepEqual(splitTarget('/json/version?token=x#frag'), { pathname: '/json/version', query: 'token=x' });
  assert.deepEqual(splitTarget(''), { pathname: '/', query: '' });
  assert.deepEqual(splitTarget('?token=x'), { pathname: '/', query: 'token=x' });
  const query = `url=https%3A%2F%2Fexample.com%2F%3Fa%3D1%2Bb&token=${TOKEN}&for_tab&tok%65n=2`;
  assert.equal(tokenFromQuery(query), TOKEN);
  assert.equal(stripTokenFromQuery(query), 'url=https%3A%2F%2Fexample.com%2F%3Fa%3D1%2Bb&for_tab');
  assert.equal(tokenFromQuery('a=1'), null);
  assert.equal(tokenFromQuery('token'), '');
  assert.equal(tokenFromQuery('token=%E0%A4%A'), null);
  assert.equal(stripTokenFromQuery(''), '');
});

test('Authorization header forms', () => {
  assert.equal(tokenFromAuthorization(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(tokenFromAuthorization(`bearer   ${TOKEN} `), TOKEN);
  assert.equal(tokenFromAuthorization(basic('obscura', TOKEN)), TOKEN);
  assert.equal(tokenFromAuthorization(basic('anyone', TOKEN)), TOKEN);
  assert.equal(tokenFromAuthorization(basic(TOKEN, '')), TOKEN);
  assert.equal(tokenFromAuthorization(`Basic ${Buffer.from(TOKEN).toString('base64')}`), TOKEN);
  assert.equal(tokenFromAuthorization('Digest abc'), null);
  assert.equal(tokenFromAuthorization(undefined), null);
});

test('token matcher is exact', () => {
  const matches = createTokenMatcher(TOKEN);
  assert.equal(matches(TOKEN), true);
  assert.equal(matches(`${TOKEN}x`), false);
  assert.equal(matches(TOKEN.slice(1)), false);
  assert.equal(matches(''), false);
  assert.equal(matches(null), false);
  const req = (authorization) => ({ headers: authorization ? { authorization } : {} });
  assert.equal(isAuthorized(req(), `token=${TOKEN}`, matches), true);
  assert.equal(isAuthorized(req(`Bearer ${TOKEN}`), '', matches), true);
  assert.equal(isAuthorized(req('Bearer wrong-token-000000000'), 'token=nope', matches), false);
  assert.equal(isAuthorized(req(), '', matches), false);
});

test('origin policy: none, same site or allowlisted', () => {
  const headers = (origin) => ({ host: 'obscura.up.railway.app', ...(origin === undefined ? {} : { origin }) });
  assert.equal(isOriginAllowed(headers(undefined), []), true);
  assert.equal(isOriginAllowed(headers('https://obscura.up.railway.app'), []), true);
  assert.equal(isOriginAllowed(headers('http://obscura.up.railway.app'), []), true);
  assert.equal(isOriginAllowed(headers('https://evil.example'), []), false);
  assert.equal(isOriginAllowed(headers('null'), []), false);
  assert.equal(isOriginAllowed(headers('https://evil.example'), ['https://evil.example']), true);
  assert.equal(isOriginAllowed(headers('https://evil.example'), ['*']), true);
  assert.equal(isOriginAllowed({ origin: 'https://a.example' }, []), false);
  assert.equal(isOriginAllowed({ origin: ['a', 'b'] }, ['*']), false);
});
