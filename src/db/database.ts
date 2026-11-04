import Database from 'better-sqlite3';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema';
import { SEED_PRODUCTS } from './seed';

/** Drizzle database handle. `db.$client` is the underlying better-sqlite3 connection. */
export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Transaction handle passed to `db.transaction(tx => ...)` callbacks. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

// Works from both src/db (ts-node, tests) and dist/db (compiled).
const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', '..', 'drizzle');

/**
 * Opens (or creates) the SQLite database, applies pending migrations and seeds products.
 *
 * WAL mode lets readers proceed while one writer holds the write lock, and the
 * busy timeout makes a second writer (another request or another process)
 * wait for the lock instead of failing immediately.
 */
export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  // `timeout` sets SQLite's busy timeout from the very first statement.
  const sqlite = new Database(dbPath, { timeout: 5000 });

  // Startup can fail with SQLITE_BUSY even with a busy timeout: seen on macOS
  // when two instances started on a new file at the same moment (the WAL
  // switch failed). The likely cause is that switching to WAL needs a lock
  // upgrade, and when two connections both want to upgrade, SQLite returns
  // SQLITE_BUSY instead of waiting, to avoid a deadlock. Each startup step is
  // safe to repeat, so a lost race is retried after a short pause.
  withStartupRetry(() => sqlite.pragma('journal_mode = WAL'));
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema }) as DB;
  // Drizzle's migrator checks which migrations were applied *before* it opens
  // its transaction, so an instance that loses the race can also hit "table
  // already exists". Re-running migrate() re-reads the applied list and skips
  // what is done. In production, migrations run once as a deploy step
  // (`npm run db:migrate`).
  withStartupRetry(() => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }));
  withStartupRetry(() => seedProducts(db));
  return db;
}

const LOST_STARTUP_RACE = /SQLITE_BUSY|database is locked|already exists/i;

/** Runs a repeatable startup step, retrying for up to ~5 s if it lost a lock race with another instance. */
export function withStartupRetry<T>(step: () => T, attempts = 25): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return step();
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const lostRace = LOST_STARTUP_RACE.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
      if (!lostRace || attempt >= attempts) throw error;
      sleepSync(100 + Math.floor(Math.random() * 100));
    }
  }
}

/** Blocks the thread briefly. Only used during startup, before the server accepts requests. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function seedProducts(db: DB): void {
  const now = new Date().toISOString();
  db.transaction(
    (tx) => {
      tx.insert(schema.products)
        .values(SEED_PRODUCTS.map((p) => ({ ...p, updatedAt: now })))
        .onConflictDoNothing()
        .run();
    },
    { behavior: 'immediate' },
  );
}
