// Wires configuration, the Obscura supervisor and the gate server together.

import { buildObscuraArgs, buildObscuraEnv } from './args.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createGateServer } from './server.js';
import { createSessionRegistry } from './sessions.js';
import { createSupervisor } from './supervisor.js';
import { cachedProbe, probeObscura } from './upstream.js';

function listen(server, port, log) {
  return new Promise((resolve, reject) => {
    const attempt = (host, fallback) => {
      const onError = (error) => {
        server.off('listening', onListening);
        if (fallback && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
          log.warn('IPv6 is not available, listening on IPv4 only', { error: error.code });
          attempt('0.0.0.0', false);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // "::" accepts IPv4 and IPv6 (Railway private networking resolves both).
      server.listen({ port, host, ipv6Only: false });
    };
    attempt('::', true);
  });
}

function describeStartup(config, log) {
  const domain = config.publicDomain || '{your-domain}';
  log.info('configuration', {
    stealth: config.stealth,
    workers: config.workers,
    block_private_networks: config.blockPrivateNetworks,
    max_sessions: config.maxSessions || 'unlimited',
    idle_timeout_s: config.idleTimeoutMs / 1000 || 'off',
    session_timeout_s: config.sessionTimeoutMs / 1000 || 'off',
  });
  log.info(`CDP endpoint: wss://${domain}?token={OBSCURA_TOKEN} (discovery: https://${domain}/json/version?token=...)`);
}

/**
 * Starts the gate and Obscura. Returns handles for shutdown (and tests).
 * @param {Record<string, string|undefined>} env
 * @param {{ log?: object, onFatal?: (reason: string) => void, spawnImpl?: Function,
 *           supervisorTiming?: object, internalToken?: string }} deps
 */
export async function startApp(env, deps = {}) {
  const config = loadConfig(env, { internalToken: deps.internalToken });
  const log = deps.log ?? createLogger({ level: config.gateLogLevel });
  const onFatal = deps.onFatal ?? (() => {});
  const sessions = createSessionRegistry({ max: config.maxSessions });
  const supervisor = createSupervisor({
    bin: config.obscuraBin,
    args: buildObscuraArgs(config),
    env: buildObscuraEnv(env, config),
    log,
    onGiveUp: (reason) => {
      log.error('giving up on obscura', { reason });
      onFatal(reason);
    },
    spawnImpl: deps.spawnImpl,
    timing: deps.supervisorTiming,
  });
  const probe = cachedProbe(() => probeObscura(config), 2000);
  const server = createGateServer({
    config,
    log,
    sessions,
    supervisor,
    isHealthy: async () => supervisor.state().status === 'running' && probe(),
  });

  const address = await listen(server, config.port, log);
  log.info('gate listening', { address: address.address, port: address.port });
  describeStartup(config, log);
  supervisor.start();

  let stopping = null;
  const stop = () => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      log.info('shutting down', { open_sessions: sessions.active });
      server.close();
      sessions.closeAll();
      server.closeAllConnections();
      await supervisor.stop();
    })();
    return stopping;
  };

  return Object.freeze({ config, server, sessions, supervisor, port: address.port, stop });
}
