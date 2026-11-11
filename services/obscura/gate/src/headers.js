// Header handling between the client, the gate and Obscura.
//
// Obscura refuses requests whose Host does not name its loopback bind
// address, any request with an Origin header, and requests without its CDP
// bearer token. The gate has already checked the public token and the Origin,
// so it sends Obscura a loopback Host and the internal token, drops Origin,
// and never forwards the client's credentials.

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const NEVER_FORWARD = new Set([
  'host',
  'origin',
  'authorization',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

function connectionTokens(headers) {
  const value = headers.connection;
  const text = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return new Set(
    text
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
}

/**
 * Request headers for a plain HTTP request to Obscura.
 * @param {Record<string, string|string[]|undefined>} headers incoming (lower-case keys)
 * @param {{ host: string, authorization: string, identityEncoding: boolean }} options
 * @returns {Record<string, string|string[]>}
 */
export function upstreamRequestHeaders(headers, { host, authorization, identityEncoding }) {
  const listed = connectionTokens(headers);
  const kept = Object.entries(headers).filter(
    ([name, value]) =>
      value !== undefined && !HOP_BY_HOP.has(name) && !NEVER_FORWARD.has(name) && !listed.has(name),
  );
  const encoding = identityEncoding ? { 'accept-encoding': 'identity' } : {};
  return { ...Object.fromEntries(kept), ...encoding, host, authorization };
}

/**
 * Response headers to send back to the client.
 * @param {Record<string, string|string[]|undefined>} headers from Obscura
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string|string[]>}
 */
export function downstreamResponseHeaders(headers, overrides = {}) {
  const listed = connectionTokens(headers);
  const kept = Object.entries(headers).filter(
    ([name, value]) => value !== undefined && !HOP_BY_HOP.has(name) && !listed.has(name),
  );
  return { ...Object.fromEntries(kept), ...overrides };
}

/**
 * Raw HTTP/1.1 request head for a WebSocket upgrade to Obscura. Keeps the
 * client's header order and the Upgrade/Connection/Sec-WebSocket-* headers.
 * @param {string[]} rawHeaders req.rawHeaders (name, value, name, value, ...)
 * @param {string} target path and query for Obscura
 * @param {{ host: string, authorization: string }} upstream loopback Host and internal token
 * @returns {string}
 */
export function upgradeRequestHead(rawHeaders, target, { host, authorization }) {
  const lines = [`GET ${target} HTTP/1.1`, `Host: ${host}`, `Authorization: ${authorization}`];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (!NEVER_FORWARD.has(name.toLowerCase())) lines.push(`${name}: ${rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * True for a WebSocket upgrade request.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isWebSocketUpgrade(req) {
  const upgrade = typeof req.headers.upgrade === 'string' ? req.headers.upgrade.toLowerCase() : '';
  return req.method === 'GET' && upgrade === 'websocket' && connectionTokens(req.headers).has('upgrade');
}
