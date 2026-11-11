import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSupervisor } from '../src/supervisor.js';
import { captureLog, delay } from './helpers.js';

const fastTiming = { minDelayMs: 10, maxDelayMs: 40, stableAfterMs: 200, fastFailureMs: 100, maxFastFailures: 3, stopGraceMs: 50 };

// Fake child processes the test can crash on demand.
function scriptedSpawn() {
  const children = [];
  const spawnImpl = (bin, args, options) => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      if (!child.ignoreTerm || signal === 'SIGKILL') setImmediate(() => child.emit('exit', null, signal));
      return true;
    };
    child.options = options;
    child.args = args;
    children.push(child);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  return { children, spawnImpl };
}

test('restarts Obscura after it exits, with backoff, and reports state', async () => {
  const { children, spawnImpl } = scriptedSpawn();
  const { log, lines } = captureLog();
  const sup = createSupervisor({ bin: '/bin/obscura', args: ['serve'], env: { A: '1' }, log, onGiveUp: () => assert.fail('gave up'), spawnImpl, timing: { ...fastTiming, fastFailureMs: 0 } });
  sup.start();
  sup.start();
  await delay(5);
  assert.equal(children.length, 1);
  assert.equal(sup.state().status, 'running');
  assert.equal(sup.state().pid, 1000);
  assert.deepEqual(children[0].options.env, { A: '1' });
  assert.deepEqual(children[0].options.stdio, ['ignore', 'inherit', 'inherit']);
  children[0].emit('exit', 1, null);
  assert.equal(sup.state().status, 'backoff');
  await delay(30);
  assert.equal(children.length, 2);
  assert.equal(sup.state().restarts, 1);
  assert.ok(lines.some((l) => l.message === 'obscura exited' && l.fields.code === 1));
  await sup.stop();
  assert.equal(sup.state().status, 'stopped');
  assert.deepEqual(children[1].signals, ['SIGTERM']);
});

test('gives up after repeated fast failures', async () => {
  const { children, spawnImpl } = scriptedSpawn();
  const reasons = [];
  const sup = createSupervisor({ bin: 'obscura', args: [], env: {}, log: captureLog().log, onGiveUp: (r) => reasons.push(r), spawnImpl, timing: fastTiming });
  sup.start();
  for (let i = 0; i < 3; i += 1) {
    await delay(5);
    children.at(-1).emit('exit', 2, null);
    await delay(60);
  }
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /exited 3 times in a row/);
  assert.equal(sup.state().status, 'failed');
  assert.equal(children.length, 3);
});

test('spawn errors are fatal', async () => {
  const reasons = [];
  const throwing = createSupervisor({
    bin: 'missing',
    args: [],
    env: {},
    log: captureLog().log,
    onGiveUp: (r) => reasons.push(r),
    spawnImpl: () => {
      throw new Error('EACCES');
    },
  });
  throwing.start();
  assert.match(reasons[0], /cannot start missing: EACCES/);

  const { children, spawnImpl } = scriptedSpawn();
  const sup = createSupervisor({ bin: 'gone', args: [], env: {}, log: captureLog().log, onGiveUp: (r) => reasons.push(r), spawnImpl });
  sup.start();
  children[0].emit('error', new Error('spawn gone ENOENT'));
  assert.match(reasons[1], /ENOENT/);
  assert.equal(sup.state().status, 'failed');
});

test('stop escalates to SIGKILL and cancels pending restarts', async () => {
  const { children, spawnImpl } = scriptedSpawn();
  const sup = createSupervisor({ bin: 'obscura', args: [], env: {}, log: captureLog().log, onGiveUp: () => {}, spawnImpl, timing: fastTiming });
  sup.start();
  await delay(5);
  children[0].ignoreTerm = true;
  await sup.stop();
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL']);

  const second = scriptedSpawn();
  const sup2 = createSupervisor({ bin: 'obscura', args: [], env: {}, log: captureLog().log, onGiveUp: () => {}, spawnImpl: second.spawnImpl, timing: fastTiming });
  sup2.start();
  await delay(5);
  second.children[0].emit('exit', 1, null);
  await sup2.stop();
  await delay(40);
  assert.equal(second.children.length, 1);
  assert.equal(sup2.state().status, 'stopped');
});

test('a run longer than stableAfterMs resets the backoff', async () => {
  const { children, spawnImpl } = scriptedSpawn();
  const { log, lines } = captureLog();
  const sup = createSupervisor({ bin: 'obscura', args: [], env: {}, log, onGiveUp: () => {}, spawnImpl, timing: { ...fastTiming, maxFastFailures: 100 } });
  sup.start();
  await delay(5);
  children[0].emit('exit', 1, null);
  await delay(20);
  children[1].emit('exit', 1, null);
  await delay(50);
  await delay(220);
  children[2].emit('exit', 1, null);
  const restarts = lines.filter((l) => l.message === 'restarting obscura').map((l) => l.fields.in_ms);
  assert.deepEqual(restarts, [10, 20, 10]);
  await sup.stop();
});
