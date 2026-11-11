// Reads and validates the gate's configuration from environment variables.
// Everything is checked once at startup; a bad value stops the container with
// a clear message instead of serving an unprotected or half-working browser.

import { randomBytes } from 'node:crypto';
import { splitArgs } from './args.js';

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const OBSCURA_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'off']);
const GATE_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on', 'y', 't']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off', 'n', 'f']);
// Flags the gate owns: the internal listener must stay on loopback.
const RESERVED_FLAGS = ['--host', '--port', '-p', '--ready-file'];
// Obscura refuses a CDP token shorter than 32 bytes.
const INTERNAL_TOKEN_BYTES = 32;

export class ConfigError extends Error {}

function text(env, name, fallback = '') {
  const value = env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function parseBool(env, name, fallback) {
  const raw = text(env, name).toLowerCase();
  if (raw === '') return fallback;
  if (TRUE_WORDS.has(raw)) return true;
  if (FALSE_WORDS.has(raw)) return false;
  throw new ConfigError(`${name} must be true or false (got '${env[name]}')`);
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} name
 * @param {{ fallback: number, min: number, max: number }} range
 * @returns {number}
 */
export function parseInteger(env, name, { fallback, min, max }) {
  const raw = text(env, name);
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be a whole number (got '${raw}')`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

function parseToken(env) {
  const token = text(env, 'OBSCURA_TOKEN');
  if (token === '') {
    throw new ConfigError(
      'OBSCURA_TOKEN is empty. It protects the browser; set at least 16 characters of A-Z a-z 0-9 . _ ~ -',
    );
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new ConfigError(
      'OBSCURA_TOKEN must be 16-512 characters of A-Z a-z 0-9 . _ ~ - (URL-safe, so it works in ?token=)',
    );
  }
  return token;
}

function parseChoice(env, name, allowed, fallback) {
  const value = text(env, name, fallback).toLowerCase() || fallback;
  if (!allowed.has(value)) {
    throw new ConfigError(`${name} must be one of ${[...allowed].join(', ')} (got '${value}')`);
  }
  return value;
}

function isReservedFlag(arg) {
  return RESERVED_FLAGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`) || (flag === '-p' && /^-p\d/.test(arg)),
  );
}

function parseExtraArgs(env) {
  let args;
  try {
    args = splitArgs(text(env, 'OBSCURA_EXTRA_ARGS'));
  } catch (error) {
    throw new ConfigError(`OBSCURA_EXTRA_ARGS: ${error.message}`);
  }
  const reserved = args.find(isReservedFlag);
  if (reserved !== undefined) {
    throw new ConfigError(
      `OBSCURA_EXTRA_ARGS must not set ${reserved}: the gate keeps Obscura on 127.0.0.1`,
    );
  }
  if (args.length > 0 && !args[0].startsWith('-')) {
    throw new ConfigError('OBSCURA_EXTRA_ARGS must contain only flags for `obscura serve` (start with -)');
  }
  return Object.freeze(args);
}

function parseOrigins(env) {
  return Object.freeze(
    text(env, 'OBSCURA_ALLOWED_ORIGINS')
      .split(',')
      .map((origin) => origin.trim().toLowerCase().replace(/\/+$/, ''))
      .filter((origin) => origin !== ''),
  );
}

/**
 * Builds the immutable gate configuration. The internal token secures the
 * loopback hop to Obscura; it is random per start and never leaves the
 * container.
 * @param {Record<string, string|undefined>} env
 * @param {{ internalToken?: string }} [options]
 * @returns {Readonly<object>}
 */
export function loadConfig(env, { internalToken } = {}) {
  const port = parseInteger(env, 'PORT', { fallback: 8080, min: 1, max: 65535 });
  const internalPort = parseInteger(env, 'OBSCURA_INTERNAL_PORT', { fallback: 9222, min: 1, max: 65535 });
  if (port === internalPort) {
    throw new ConfigError(`PORT (${port}) must differ from the internal Obscura port (${internalPort})`);
  }
  return Object.freeze({
    port,
    internalHost: '127.0.0.1',
    internalPort,
    internalToken: internalToken ?? randomBytes(INTERNAL_TOKEN_BYTES).toString('hex'),
    token: parseToken(env),
    stealth: parseBool(env, 'OBSCURA_STEALTH', false),
    workers: parseInteger(env, 'OBSCURA_WORKERS', { fallback: 1, min: 1, max: 32 }),
    blockPrivateNetworks: parseBool(env, 'OBSCURA_BLOCK_PRIVATE_NETWORKS', true),
    maxSessions: parseInteger(env, 'OBSCURA_MAX_SESSIONS', { fallback: 10, min: 0, max: 10000 }),
    sessionTimeoutMs:
      parseInteger(env, 'OBSCURA_SESSION_TIMEOUT', { fallback: 0, min: 0, max: 7 * 24 * 3600 }) * 1000,
    idleTimeoutMs:
      parseInteger(env, 'OBSCURA_IDLE_TIMEOUT', { fallback: 1800, min: 0, max: 7 * 24 * 3600 }) * 1000,
    httpTimeoutMs:
      parseInteger(env, 'OBSCURA_HTTP_TIMEOUT', { fallback: 600, min: 1, max: 3600 }) * 1000,
    obscuraLogLevel: parseChoice(env, 'OBSCURA_LOG_LEVEL', OBSCURA_LOG_LEVELS, 'warn'),
    gateLogLevel: parseChoice(env, 'OBSCURA_GATE_LOG_LEVEL', GATE_LOG_LEVELS, 'info'),
    extraArgs: parseExtraArgs(env),
    allowedOrigins: parseOrigins(env),
    obscuraBin: text(env, 'OBSCURA_BIN', '/usr/local/bin/obscura') || '/usr/local/bin/obscura',
    publicDomain: text(env, 'RAILWAY_PUBLIC_DOMAIN'),
  });
}
