// Small requests from the gate to Obscura on loopback: the readiness probe.
// Obscura checks Host (it must name its own loopback address) and the CDP
// bearer token on every request, so both are set here.

import http from 'node:http';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Host header Obscura accepts: its bind address and port.
 * @param {{ internalHost: string, internalPort: number }} config
 * @returns {string}
 */
export function upstreamHostHeader(config) {
  return `${config.internalHost}:${config.internalPort}`;
}

/**
 * Authorization header for Obscura (the internal token, never the public one).
 * @param {{ internalToken: string }} config
 * @returns {string}
 */
export function upstreamAuthorization(config) {
  return `Bearer ${config.internalToken}`;
}

/**
 * GET a small resource from Obscura.
 * @param {object} config
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: Buffer }>}
 */
export function getFromObscura(config, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: config.internalHost,
      port: config.internalPort,
      method: 'GET',
      path,
      agent: false,
      headers: {
        host: upstreamHostHeader(config),
        authorization: upstreamAuthorization(config),
        accept: 'application/json',
        connection: 'close',
      },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.end();
  });
}

/**
 * True when Obscura answers /json/version with a browser endpoint. Obscura
 * serves /json/* on its accept thread, so this stays fast while pages run.
 * @param {object} config
 * @returns {Promise<boolean>}
 */
export async function probeObscura(config) {
  try {
    const { status, body } = await getFromObscura(config, '/json/version', 2000);
    if (status !== 200) return false;
    return typeof JSON.parse(body.toString('utf8')).webSocketDebuggerUrl === 'string';
  } catch {
    return false;
  }
}

/**
 * Caches the probe result briefly so public health checks cannot be used to
 * hammer Obscura.
 * @param {() => Promise<boolean>} probe
 * @param {number} ttlMs
 * @returns {() => Promise<boolean>}
 */
export function cachedProbe(probe, ttlMs) {
  let cached = null;
  let inFlight = null;
  return async () => {
    if (cached !== null && Date.now() - cached.at < ttlMs) return cached.ok;
    if (inFlight === null) {
      inFlight = probe()
        .then((ok) => {
          cached = { ok, at: Date.now() };
          return ok;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
