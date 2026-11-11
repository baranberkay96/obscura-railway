// Entry point: `node src/main.js` (started by tini in the image).

import { startApp } from './app.js';
import { ConfigError } from './config.js';
import { createLogger } from './log.js';

const SHUTDOWN_DEADLINE_MS = 8000;
const bootLog = createLogger({ level: 'info' });

let app = null;
let exiting = false;

function shutdown(reason, exitCode) {
  if (exiting) return;
  exiting = true;
  bootLog.info('stopping', { reason });
  if (app === null) {
    process.exit(exitCode);
  }
  const deadline = setTimeout(() => process.exit(exitCode), SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  app.stop().then(
    () => process.exit(exitCode),
    () => process.exit(1),
  );
}

async function main() {
  try {
    app = await startApp(process.env, { onFatal: () => shutdown('obscura keeps failing', 1) });
  } catch (error) {
    bootLog.error(error instanceof ConfigError ? `configuration error: ${error.message}` : error.message);
    process.exit(1);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));
}

process.on('uncaughtException', (error) => {
  bootLog.error('uncaught exception', { error: error.stack ?? String(error) });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  bootLog.error('unhandled rejection', { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});

main();
