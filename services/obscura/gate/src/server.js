// The public HTTP server on $PORT. Order of checks for every request and
// WebSocket upgrade:
//   1. /health and /robots.txt are public (no data).
//   2. A request with an Origin header must come from this site (or
//      OBSCURA_ALLOWED_ORIGINS): blocks cross-site use of cached credentials.
//   3. The token must be present (?token=, Bearer or Basic) - otherwise 401.
//   4. Authorized traffic goes to Obscura on loopback; the public token is
//      removed and the internal one added. Plain HTTP is limited to CDP
//      discovery, which is all Obscura serves without a WebSocket.

import http from 'node:http';
import { createTokenMatcher, isAuthorized, isOriginAllowed, splitTarget, stripTokenFromQuery } from './auth.js';
import { isWebSocketUpgrade } from './headers.js';
import { createHttpProxy, sendJson } from './http-proxy.js';
import { createRateLimitedCounter } from './log.js';
import { clientOrigin, internalWsPrefixes } from './rewrite.js';
import { createWsProxy, rejectUpgrade } from './ws-proxy.js';

const PUBLIC_PATHS = new Set(['/health', '/healthz', '/robots.txt']);
const DISCOVERY_PATHS = new Set([
  '/json',
  '/json/list',
  '/json/list/',
  '/json/version',
  '/json/version/',
  '/json/protocol',
  '/json/protocol/',
]);
const UNAUTHORIZED = Object.freeze({
  error: 'unauthorized',
  message: 'Send the OBSCURA_TOKEN as ?token=..., as "Authorization: Bearer ..." or as the Basic auth password',
});
const FORBIDDEN_ORIGIN = Object.freeze({
  error: 'origin_not_allowed',
  message: 'Cross-site requests are refused; add the origin to OBSCURA_ALLOWED_ORIGINS to allow it',
});
const NOT_FOUND = Object.freeze({
  error: 'not_found',
  message: 'Connect a CDP client to wss://{this-host}?token=... or read /json/version',
});

function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim() !== '') return forwarded.split(',', 1)[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim() !== '') return real.trim();
  return req.socket?.remoteAddress ?? '';
}

function describeRequest(req, config) {
  const { pathname, query } = splitTarget(req.url);
  const upstreamQuery = stripTokenFromQuery(query);
  const origin = clientOrigin(req.headers, {
    fallbackHost: config.publicDomain || `127.0.0.1:${config.port}`,
    publicDomain: config.publicDomain,
  });
  return {
    pathname,
    query,
    upstreamQuery,
    upstreamTarget: upstreamQuery ? `${pathname}?${upstreamQuery}` : pathname,
    clientIp: clientAddress(req),
    rewriteContext: {
      prefixes: internalWsPrefixes(config),
      secure: origin.secure,
      host: origin.host,
      token: config.token,
    },
  };
}

function sendHealth(res, healthy, method) {
  const status = healthy ? 200 : 503;
  if (method === 'HEAD') {
    res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  sendJson(res, status, { status: healthy ? 'ok' : 'starting' });
}

function servePublic(req, res, pathname, isHealthy) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
    return;
  }
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'User-agent: *\nDisallow: /\n');
    return;
  }
  isHealthy().then(
    (healthy) => sendHealth(res, healthy, req.method),
    () => sendHealth(res, false, req.method),
  );
}

function infoDocument(config, sessions, supervisor, route) {
  const scheme = route.rewriteContext.secure ? 'https' : 'http';
  const wsScheme = route.rewriteContext.secure ? 'wss' : 'ws';
  const host = route.rewriteContext.host;
  return {
    service: 'obscura-gate',
    obscura: {
      ...supervisor.state(),
      stealth: config.stealth,
      workers: config.workers,
      blockPrivateNetworks: config.blockPrivateNetworks,
    },
    sessions: { open: sessions.active, max: sessions.max },
    connect: {
      cdp: `${wsScheme}://${host}?token={OBSCURA_TOKEN}`,
      cdpDiscovery: `${scheme}://${host}/json/version?token={OBSCURA_TOKEN}`,
    },
  };
}

/**
 * Creates the gate server (not yet listening).
 * @param {{ config: object, log: object, sessions: object, supervisor: object,
 *           isHealthy: () => Promise<boolean> }} deps
 * @returns {import('node:http').Server}
 */
export function createGateServer({ config, log, sessions, supervisor, isHealthy }) {
  const matches = createTokenMatcher(config.token);
  const proxyHttp = createHttpProxy({ config, log });
  const proxyUpgrade = createWsProxy({ config, log, sessions });
  const failedLogins = createRateLimitedCounter({
    log,
    intervalMs: 60_000,
    message: 'unauthorized requests refused in the last minute',
  });

  const server = http.createServer((req, res) => {
    const route = describeRequest(req, config);
    if (PUBLIC_PATHS.has(route.pathname)) {
      servePublic(req, res, route.pathname, isHealthy);
      return;
    }
    if (!isOriginAllowed(req.headers, config.allowedOrigins)) {
      sendJson(res, 403, FORBIDDEN_ORIGIN);
      return;
    }
    if (!isAuthorized(req, route.query, matches)) {
      failedLogins.record({ client: route.clientIp, path: route.pathname });
      sendJson(res, 401, UNAUTHORIZED);
      return;
    }
    if (route.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, infoDocument(config, sessions, supervisor, route));
      return;
    }
    if (!DISCOVERY_PATHS.has(route.pathname)) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    proxyHttp(req, res, route);
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const route = describeRequest(req, config);
    if (!isWebSocketUpgrade(req)) {
      rejectUpgrade(socket, 400, { error: 'bad_upgrade', message: 'Only WebSocket upgrades are supported' });
      return;
    }
    if (!isOriginAllowed(req.headers, config.allowedOrigins)) {
      rejectUpgrade(socket, 403, FORBIDDEN_ORIGIN);
      return;
    }
    if (!isAuthorized(req, route.query, matches)) {
      failedLogins.record({ client: route.clientIp, path: route.pathname });
      rejectUpgrade(socket, 401, UNAUTHORIZED);
      return;
    }
    proxyUpgrade(req, socket, head, route).catch((error) => {
      log.error('upgrade failed', { path: route.pathname, error: error.message });
      socket.destroy();
    });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  // Railway's edge reuses connections; keep them open longer than its idle time.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;
  return server;
}
