// Runs `obscura serve` as a child process and restarts it when it exits, with
// exponential backoff. Railway's own init is PID 1, so nothing here relies on
// being PID 1; tini in the image reaps strays. If Obscura keeps dying right
// after start (for example a bad OBSCURA_EXTRA_ARGS flag), the supervisor
// gives up so the container exits and Railway shows the crash instead of a
// silent loop.

import { spawn } from 'node:child_process';
import { redactArgs } from './args.js';

const DEFAULTS = Object.freeze({
  minDelayMs: 1000,
  maxDelayMs: 30_000,
  stableAfterMs: 60_000,
  fastFailureMs: 10_000,
  maxFastFailures: 10,
  stopGraceMs: 5000,
});

/**
 * @param {{ bin: string, args: string[], env: Record<string,string>, log: object,
 *           onGiveUp: (reason: string) => void, spawnImpl?: Function, timing?: object }} options
 */
export function createSupervisor({ bin, args, env, log, onGiveUp, spawnImpl = spawn, timing = {} }) {
  const t = { ...DEFAULTS, ...timing };
  let child = null;
  let status = 'idle';
  let startedAt = 0;
  let restarts = 0;
  let delay = t.minDelayMs;
  let fastFailures = 0;
  let restartTimer = null;
  let stopping = false;
  let stopWaiters = [];

  const settleStop = () => {
    const waiters = stopWaiters;
    stopWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const scheduleRestart = (runtimeMs) => {
    if (runtimeMs >= t.stableAfterMs) delay = t.minDelayMs;
    fastFailures = runtimeMs < t.fastFailureMs ? fastFailures + 1 : 0;
    if (fastFailures >= t.maxFastFailures) {
      status = 'failed';
      onGiveUp(`obscura exited ${fastFailures} times in a row within ${t.fastFailureMs / 1000}s of starting`);
      return;
    }
    status = 'backoff';
    log.warn('restarting obscura', { in_ms: delay, restarts: restarts + 1 });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      restarts += 1;
      launch();
    }, delay);
    delay = Math.min(delay * 2, t.maxDelayMs);
  };

  function launch() {
    if (stopping) return;
    status = 'starting';
    startedAt = Date.now();
    let proc;
    try {
      // spawn() may add variables to the env object it gets, so pass a copy.
      proc = spawnImpl(bin, [...args], { env: { ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    } catch (error) {
      status = 'failed';
      onGiveUp(`cannot start ${bin}: ${error.message}`);
      return;
    }
    child = proc;
    proc.once('spawn', () => {
      status = 'running';
      log.info('obscura started', { pid: proc.pid });
    });
    proc.once('error', (error) => {
      if (child !== proc) return;
      child = null;
      status = 'failed';
      onGiveUp(`cannot start ${bin}: ${error.message}`);
    });
    proc.once('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      const runtimeMs = Date.now() - startedAt;
      if (stopping) {
        status = 'stopped';
        settleStop();
        return;
      }
      log.warn('obscura exited', { code, signal, after_s: (runtimeMs / 1000).toFixed(1) });
      scheduleRestart(runtimeMs);
    });
  }

  return Object.freeze({
    start() {
      if (status !== 'idle') return;
      log.info('starting obscura', { bin, args: redactArgs(args).join(' ') });
      launch();
    },
    /** Stops Obscura (SIGTERM, then SIGKILL after the grace period). */
    stop() {
      stopping = true;
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (child === null) {
        status = 'stopped';
        return Promise.resolve();
      }
      const proc = child;
      return new Promise((resolve) => {
        stopWaiters.push(resolve);
        proc.kill('SIGTERM');
        const killer = setTimeout(() => proc.kill('SIGKILL'), t.stopGraceMs);
        killer.unref();
      });
    },
    state() {
      return {
        status,
        pid: child?.pid ?? null,
        restarts,
        uptimeSeconds: status === 'running' ? Math.round((Date.now() - startedAt) / 1000) : 0,
      };
    },
  });
}
