// Build-time self-test (run by the Dockerfile): loads every module and checks
// the pure parts with a throwaway token, so a broken gate fails the build
// instead of the deploy. Does not start servers or Obscura.

import assert from 'node:assert/strict';
import { buildObscuraArgs, buildObscuraEnv } from './args.js';
import { createTokenMatcher, stripTokenFromQuery, tokenFromAuthorization } from './auth.js';
import { loadConfig } from './config.js';
import { rewriteJson } from './rewrite.js';
import './app.js';

const token = 'selftest-token-0123456789';
const env = { OBSCURA_TOKEN: token, OBSCURA_STEALTH: 'true', OBSCURA_TIMEZONE: 'UTC', PATH: '/bin' };
const config = loadConfig(env);

assert.deepEqual(buildObscuraArgs(config), ['serve', '--host', '127.0.0.1', '--port', '9222', '--stealth']);
const childEnv = buildObscuraEnv(env, config);
assert.equal(childEnv.OBSCURA_TOKEN, undefined);
assert.equal(childEnv.OBSCURA_TIMEZONE, 'UTC');
assert.equal(childEnv.OBSCURA_CDP_TOKEN, config.internalToken);
assert.ok(config.internalToken.length >= 32);
assert.equal(createTokenMatcher(token)(token), true);
assert.equal(tokenFromAuthorization(`Bearer ${token}`), token);
assert.equal(stripTokenFromQuery(`a=1&token=${token}`), 'a=1');
assert.deepEqual(
  rewriteJson(
    { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser' },
    { prefixes: ['ws://127.0.0.1:9222'], secure: true, host: 'obscura.example.com', token },
  ),
  { webSocketDebuggerUrl: `wss://obscura.example.com/devtools/browser?token=${token}` },
);

process.stdout.write('obscura-gate self-test ok\n');
