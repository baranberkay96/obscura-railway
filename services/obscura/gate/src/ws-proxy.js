// WebSocket upgrades (CDP browser and page sockets). After the checks the
// gate opens a TCP connection to Obscura, replays the handshake with a
// loopback Host and the internal token, and pipes bytes both ways, so frames,
// extensions and close codes pass through untouched.

import net from 'node:net';
import { STATUS_CODES } from 'node:http';
import { upgradeRequestHead } from './headers.js';
import { upstreamAuthorization, upstreamHostHeader } from './upstream.js';

const BROWSER_PATH = '/devtools/browser';
const BROWSER_ALIASES = new Set(['/', '/devtools/browser/']);
const KEEPALIVE_MS = 30_000;
// After one side ends (TCP FIN), the other gets this long to flush, then both
// are closed. Node's HTTP server keeps half-open sockets otherwise.
const HALF_CLOSE_GRACE_MS = 2000;

/**
 * Writes an HTTP error response on a socket that asked for an upgrade.
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} headers
 */
export function rejectUpgrade(socket, status, body, headers = {}) {
  if (socket.destroyed) return;
  const payload = `${JSON.stringify(body)}\n`;
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      'Cache-Control: no-store\r\n' +
      'Connection: close\r\n' +
      `${extra.join('')}\r\n${payload}`,
  );
}

/**
 * Path sent to Obscura. The root maps to Obscura's browser endpoint, so
 * `wss://{domain}?token=...` works as a Browserless-style endpoint.
 * @param {string} pathname
 * @returns {string}
 */
export function upstreamWsPath(pathname) {
  return BROWSER_ALIASES.has(pathname) ? BROWSER_PATH : pathname;
}

function startTimers(socket, close, config) {
  if (config.idleTimeoutMs > 0) {
    socket.setTimeout(config.idleTimeoutMs, () => close('idle_timeout'));
  }
  if (config.sessionTimeoutMs > 0) {
    const timer = setTimeout(() => close('session_timeout'), config.sessionTimeoutMs);
    timer.unref();
    return () => clearTimeout(timer);
  }
  return () => {};
}

/**
 * Creates the upgrade handler.
 * @param {{ config: object, log: object, sessions: object }} deps
 */
export function createWsProxy({ config, log, sessions }) {
  const upstreamHeaders = { host: upstreamHostHeader(config), authorization: upstreamAuthorization(config) };

  return async (req, socket, head, { pathname, upstreamQuery, clientIp }) => {
    const lease = sessions.tryAcquire();
    if (lease === null) {
      log.warn('session limit reached, upgrade refused', { path: pathname, limit: sessions.max, client: clientIp });
      rejectUpgrade(
        socket,
        429,
        { error: 'too_many_sessions', message: `OBSCURA_MAX_SESSIONS (${sessions.max}) sessions are open` },
        { 'Retry-After': '5' },
      );
      return;
    }

    if (socket.destroyed) {
      lease.release();
      return;
    }

    const upstreamPath = upstreamWsPath(pathname);
    const target = upstreamQuery ? `${upstreamPath}?${upstreamQuery}` : upstreamPath;
    const upstream = net.connect({ host: config.internalHost, port: config.internalPort });
    const startedAt = Date.now();
    let connected = false;
    let closed = false;
    let stopTimers = () => {};
    let graceTimer = null;

    const close = (reason) => {
      if (closed) return;
      closed = true;
      stopTimers();
      if (graceTimer !== null) clearTimeout(graceTimer);
      lease.release();
      upstream.destroy();
      socket.destroy();
      if (connected) {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        log.info('session closed', { id: lease.id, path: pathname, reason, seconds, open: sessions.active });
      }
    };
    lease.attach(() => close('shutdown'));
    const closeSoon = (reason) => {
      if (closed || graceTimer !== null) return;
      graceTimer = setTimeout(() => close(reason), HALF_CLOSE_GRACE_MS);
      graceTimer.unref();
    };

    upstream.on('connect', () => {
      connected = true;
      upstream.setNoDelay(true);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, KEEPALIVE_MS);
      upstream.write(upgradeRequestHead(req.rawHeaders, target, upstreamHeaders));
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      stopTimers = startTimers(socket, close, config);
      log.info('session opened', { id: lease.id, path: pathname, client: clientIp, open: sessions.active });
    });

    upstream.on('error', (error) => {
      if (!connected) {
        log.warn('cannot reach Obscura for upgrade', { path: pathname, error: error.message });
        closed = true;
        lease.release();
        rejectUpgrade(socket, 502, { error: 'obscura_unavailable', message: 'Obscura is starting or restarting' });
        return;
      }
      close('upstream_error');
    });
    upstream.on('end', () => closeSoon('upstream_closed'));
    upstream.on('close', () => close('upstream_closed'));
    socket.on('end', () => closeSoon('client_closed'));
    socket.on('error', () => close('client_error'));
    socket.on('close', () => close('client_closed'));
  };
}
