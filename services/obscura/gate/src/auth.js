// Token checks for every request and WebSocket upgrade. Accepted forms:
//   ?token=<token>                     (Browserless style, works for any client)
//   Authorization: Bearer <token>      (Playwright/Puppeteer headers, curl)
//   Authorization: Basic base64(user:<token>)   (curl -u, HTTP clients)

import { createHash, timingSafeEqual } from 'node:crypto';

const TOKEN_PARAM = 'token';

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

/**
 * Constant-time token comparison (both sides hashed to equal length first).
 * @param {string} token the configured OBSCURA_TOKEN
 * @returns {(candidate: string|null) => boolean}
 */
export function createTokenMatcher(token) {
  const expectedDigest = digest(token);
  return (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return false;
    return timingSafeEqual(digest(candidate), expectedDigest);
  };
}

/**
 * Splits a raw request target into path and raw query (without '?').
 * @param {string} target
 * @returns {{ pathname: string, query: string }}
 */
export function splitTarget(target) {
  const raw = typeof target === 'string' && target !== '' ? target : '/';
  const hashless = raw.split('#', 1)[0];
  const index = hashless.indexOf('?');
  const pathname = index === -1 ? hashless : hashless.slice(0, index);
  const query = index === -1 ? '' : hashless.slice(index + 1);
  return { pathname: pathname === '' ? '/' : pathname, query };
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function isTokenPair(pair) {
  const key = pair.split('=', 1)[0];
  return decodeComponent(key) === TOKEN_PARAM;
}

/**
 * Returns the first ?token= value, if any.
 * @param {string} query raw query string
 * @returns {string|null}
 */
export function tokenFromQuery(query) {
  if (!query) return null;
  const pair = query.split('&').find(isTokenPair);
  if (pair === undefined) return null;
  const eq = pair.indexOf('=');
  return eq === -1 ? '' : decodeComponent(pair.slice(eq + 1));
}

/**
 * Removes every token parameter and keeps the rest of the query byte for byte
 * (re-encoding could change values the upstream parses itself).
 * @param {string} query
 * @returns {string}
 */
export function stripTokenFromQuery(query) {
  if (!query) return '';
  return query
    .split('&')
    .filter((pair) => pair !== '' && !isTokenPair(pair))
    .join('&');
}

/**
 * Token from an Authorization header (Bearer, or the Basic password; the
 * Basic user name counts when the password is empty).
 * @param {string|undefined} header
 * @returns {string|null}
 */
export function tokenFromAuthorization(header) {
  if (typeof header !== 'string') return null;
  const match = /^\s*(bearer|basic)\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;
  if (match[1].toLowerCase() === 'bearer') return match[2];
  const decoded = Buffer.from(match[2], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return decoded;
  const password = decoded.slice(colon + 1);
  return password !== '' ? password : decoded.slice(0, colon);
}

/**
 * True when the request carries the right token in any accepted form.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} query raw query string
 * @param {(candidate: string|null) => boolean} matches
 * @returns {boolean}
 */
export function isAuthorized(req, query, matches) {
  return matches(tokenFromQuery(query)) || matches(tokenFromAuthorization(req.headers.authorization));
}

/**
 * Browsers attach cached credentials to cross-site requests, so a request
 * that carries an Origin must come from this site or an allowed origin.
 * Clients without an Origin header (Playwright, Puppeteer, Node, Python) pass.
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {readonly string[]} allowedOrigins lower-case, no trailing slash; '*' allows all
 * @returns {boolean}
 */
export function isOriginAllowed(headers, allowedOrigins) {
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  const normalized = origin.trim().toLowerCase();
  if (allowedOrigins.includes('*') || allowedOrigins.includes(normalized)) return true;
  const host = typeof headers.host === 'string' ? headers.host.trim().toLowerCase() : '';
  if (host === '') return false;
  return normalized === `https://${host}` || normalized === `http://${host}`;
}
