// Small leveled logger. One line per event, "key=value" fields, never secrets:
// callers pass paths, not full URLs, so query strings (which may carry the
// token) never reach the log.

export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function formatValue(value) {
  const text = String(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function formatFields(fields) {
  if (!fields) return '';
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function defaultWrite(level, line) {
  const stream = LOG_LEVELS[level] >= LOG_LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export function createLogger({ level = 'info', write = defaultWrite } = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const emit = (name) => (message, fields) => {
    if (LOG_LEVELS[name] < threshold) return;
    write(name, `[obscura-gate] ${name.toUpperCase()} ${message}${formatFields(fields)}`);
  };
  return Object.freeze({
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  });
}

// Collapses repeated events (for example failed logins) into one line per
// interval so a scanner cannot flood the deploy logs.
export function createRateLimitedCounter({ log, intervalMs, message }) {
  let count = 0;
  let last = {};
  let timer = null;

  const flush = () => {
    timer = null;
    if (count === 0) return;
    log.warn(message, { count, ...last });
    count = 0;
  };

  return Object.freeze({
    record(fields) {
      count += 1;
      last = { ...fields };
      if (timer === null) {
        timer = setTimeout(flush, intervalMs);
        timer.unref();
      }
    },
    flush,
  });
}
