// Rewrites the WebSocket URLs Obscura advertises. Obscura builds them from the
// Host header it receives, which the gate sets to its loopback address
// (ws://127.0.0.1:9222/...). That is useless to a remote client, so discovery
// responses are rewritten to the address the client used
// (wss://{public-domain}/... or ws://{private-host}:{port}/...) with the token
// appended, so clients that connect without headers still authenticate.

const DISCOVERY_PATHS = new Set([
  '/json',
  '/json/',
  '/json/list',
  '/json/list/',
  '/json/version',
  '/json/version/',
]);
const HOST_PATTERN = /^(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}(?::\d{1,5})?$/;
const IPV6_HOST_PATTERN = /^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;
export const MAX_REWRITE_BYTES = 4 * 1024 * 1024;

/**
 * Responses whose JSON contains Obscura's internal WebSocket URLs.
 * @param {string} pathname
 * @returns {boolean}
 */
export function shouldRewrite(pathname) {
  return DISCOVERY_PATHS.has(pathname);
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isValidHost(host) {
  return typeof host === 'string' && (HOST_PATTERN.test(host) || IPV6_HOST_PATTERN.test(host));
}

function isRailwayPublicHost(host, publicDomain) {
  const name = host.toLowerCase();
  return name.endsWith('.up.railway.app') || (publicDomain !== '' && name === publicDomain.toLowerCase());
}

/**
 * Scheme and host the client used to reach the gate. Railway's edge
 * terminates TLS and sets X-Forwarded-Proto: https; the Railway public domain
 * is HTTPS-only either way. Private-network clients use plain HTTP.
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {{ fallbackHost: string, publicDomain?: string }} options
 * @returns {{ secure: boolean, host: string }}
 */
export function clientOrigin(headers, { fallbackHost, publicDomain = '' }) {
  const forwarded = typeof headers['x-forwarded-proto'] === 'string' ? headers['x-forwarded-proto'] : '';
  const requested = typeof headers.host === 'string' ? headers.host.trim() : '';
  const host = isValidHost(requested) ? requested : fallbackHost;
  const secure =
    forwarded.split(',', 1)[0].trim().toLowerCase() === 'https' || isRailwayPublicHost(host, publicDomain);
  return { secure, host };
}

/**
 * @param {string} url
 * @param {string} token
 * @returns {string}
 */
export function appendToken(url, token) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * @param {{ internalHost: string, internalPort: number }} config
 * @returns {string[]} prefixes such as "ws://127.0.0.1:9222"
 */
export function internalWsPrefixes(config) {
  return [`ws://${config.internalHost}:${config.internalPort}`, `ws://localhost:${config.internalPort}`];
}

function stripPrefix(value, prefixes) {
  for (const prefix of prefixes) {
    if (value === prefix) return '/';
    if (value.startsWith(`${prefix}/`)) return value.slice(prefix.length);
  }
  return null;
}

/**
 * ws://127.0.0.1:9222/devtools/page/X -> wss://{host}/devtools/page/X?token=...
 * @returns {string|null} null when the value is not an internal URL
 */
export function rewriteWsUrl(value, ctx) {
  const rest = stripPrefix(value, ctx.prefixes);
  if (rest === null) return null;
  const scheme = ctx.secure ? 'wss' : 'ws';
  return appendToken(`${scheme}://${ctx.host}${rest}`, ctx.token);
}

function rewriteValue(value, ctx) {
  if (typeof value === 'string') return rewriteWsUrl(value, ctx) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, ctx));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteValue(child, ctx)]));
  }
  return value;
}

/**
 * Returns a rewritten copy of a parsed JSON document.
 * @param {unknown} document
 * @param {{ prefixes: string[], secure: boolean, host: string, token: string }} ctx
 * @returns {unknown}
 */
export function rewriteJson(document, ctx) {
  return rewriteValue(document, ctx);
}

/**
 * @param {Buffer} body
 * @param {object} ctx
 * @returns {Buffer|null} the rewritten body, or null if it is not JSON
 */
export function rewriteBody(body, ctx) {
  let document;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  return Buffer.from(JSON.stringify(rewriteJson(document, ctx)), 'utf8');
}
