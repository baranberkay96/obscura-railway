// Builds the `obscura serve` command line and the environment Obscura runs
// with. OBSCURA_EXTRA_ARGS is split like a shell would (quotes and backslashes), but
// nothing is ever evaluated by a shell.

/**
 * Splits a command-line string into arguments. Supports single quotes,
 * double quotes (with \" and \\ escapes) and backslash escapes.
 * @param {string} input
 * @returns {string[]}
 */
export function splitArgs(input) {
  const args = [];
  let current = '';
  let inArg = false;
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        current += input[i + 1];
        i += 1;
      } else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inArg = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      inArg = true;
      i += 1;
    } else if (/\s/.test(ch)) {
      if (inArg) args.push(current);
      current = '';
      inArg = false;
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (quote !== null) throw new Error(`unterminated ${quote} quote`);
  if (inArg) args.push(current);
  return args;
}

function hasFlag(args, names) {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

/**
 * Arguments for `obscura serve`. Switches are only added when
 * OBSCURA_EXTRA_ARGS does not already contain them, because Obscura rejects
 * repeated flags.
 * @param {Readonly<object>} config
 * @returns {string[]}
 */
export function buildObscuraArgs(config) {
  const extra = config.extraArgs;
  const optional = [
    [config.stealth, ['--stealth'], ['--stealth']],
    [config.workers > 1, ['--workers'], ['--workers', String(config.workers)]],
    [!config.blockPrivateNetworks, ['--allow-private-network'], ['--allow-private-network']],
  ]
    .filter(([enabled, names]) => enabled && !hasFlag(extra, names))
    .flatMap(([, , flags]) => flags);
  return ['serve', '--host', config.internalHost, '--port', String(config.internalPort), ...optional, ...extra];
}

// Flags whose values can hold credentials (proxy URLs with user:password).
const SENSITIVE_FLAGS = new Set(['--proxy']);

/**
 * Copy of the argument list that is safe to log.
 * @param {string[]} args
 * @returns {string[]}
 */
export function redactArgs(args) {
  return args.map((arg, index) => {
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1 && SENSITIVE_FLAGS.has(arg.slice(0, eq))) {
      return `${arg.slice(0, eq)}=***`;
    }
    return index > 0 && SENSITIVE_FLAGS.has(args[index - 1]) ? '***' : arg;
  });
}

const PASSTHROUGH_ENV = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NO_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'RUST_BACKTRACE',
  'RUST_LOG',
]);

// OBSCURA_* variables the gate owns or decides itself. Everything else with
// the prefix (OBSCURA_PROXY, OBSCURA_TIMEZONE, OBSCURA_NAV_TIMEOUT_MS, ...)
// is Obscura's own tuning and passes through unchanged.
const GATE_OWNED_ENV = new Set([
  'OBSCURA_TOKEN',
  'OBSCURA_STEALTH',
  'OBSCURA_WORKERS',
  'OBSCURA_BLOCK_PRIVATE_NETWORKS',
  'OBSCURA_MAX_SESSIONS',
  'OBSCURA_SESSION_TIMEOUT',
  'OBSCURA_IDLE_TIMEOUT',
  'OBSCURA_HTTP_TIMEOUT',
  'OBSCURA_LOG_LEVEL',
  'OBSCURA_GATE_LOG_LEVEL',
  'OBSCURA_EXTRA_ARGS',
  'OBSCURA_ALLOWED_ORIGINS',
  'OBSCURA_BIN',
  'OBSCURA_INTERNAL_PORT',
  // The gate sets the CDP token, checks origins and chooses the private
  // network policy (OBSCURA_BLOCK_PRIVATE_NETWORKS). Obscura's MCP server is
  // not started.
  'OBSCURA_CDP_TOKEN',
  'OBSCURA_CDP_ALLOWED_ORIGINS',
  'OBSCURA_ALLOW_PRIVATE_NETWORK',
  'OBSCURA_MCP_TOKEN',
  'OBSCURA_MCP_ALLOWED_ORIGINS',
]);

function isObscuraTuning(name) {
  return name.startsWith('OBSCURA_') && !GATE_OWNED_ENV.has(name);
}

/**
 * Environment for the Obscura child: an allowlist, Obscura's own tuning
 * variables and the internal CDP token. Never the public token, never
 * Railway variables.
 * @param {Record<string, string|undefined>} env
 * @param {Readonly<object>} config
 * @returns {Record<string, string>}
 */
export function buildObscuraEnv(env, config) {
  const entries = Object.entries(env).filter(
    ([name, value]) =>
      typeof value === 'string' && value.trim() !== '' && (PASSTHROUGH_ENV.includes(name) || isObscuraTuning(name)),
  );
  return Object.freeze({
    NO_COLOR: '1',
    RUST_LOG: config.obscuraLogLevel,
    ...Object.fromEntries(entries),
    OBSCURA_CDP_TOKEN: config.internalToken,
  });
}
