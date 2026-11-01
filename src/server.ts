import { loadConfig } from './config';
import { openDatabase } from './db/database';
import { createApp } from './http/app';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp({ db, config });

const server = app.listen(config.port, () => {
  console.log(
    `checkout-rewards-service listening on :${config.port} (db=${config.dbPath}, n=${config.milestoneN}, x=${config.discountPercentX}%)`,
  );
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
