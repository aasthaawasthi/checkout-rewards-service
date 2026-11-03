/**
 * Entry point. Express 5 (5.3) on Node.js 20+.
 *
 * Express 5 passes startup failures (e.g. EADDRINUSE) to the app.listen
 * callback as its first argument instead of only emitting them on the server,
 * so the callback must check it before reporting the server as up.
 */
import process from 'node:process';
import { loadConfig } from './config';
import { openDatabase } from './db/database';
import { createApp } from './http/app';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp({ db, config });

const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    console.error(`Failed to start on port ${config.port}: ${error.message}`);
    db.$client.close();
    process.exit(1);
  }
  console.log(
    `checkout-rewards-service listening on :${config.port} (db=${config.dbPath}, n=${config.milestoneN}, x=${config.discountPercentX}%)`,
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, closing server`);

  // Stop accepting new connections; in-flight requests finish (each checkout
  // is a short synchronous transaction, so there is never half a checkout).
  server.close(() => {
    db.$client.close();
    process.exit(0);
  });
  server.closeIdleConnections();

  // Do not hang forever on a stuck keep-alive connection.
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    db.$client.close();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection', reason);
  process.exit(1);
});
