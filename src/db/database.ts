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
 * WAL mode lets readers proceed while one writer holds the write lock, and
 * busy_timeout makes a second writer (another request or another process)
 * wait for the lock instead of failing immediately.
 */
export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema }) as DB;
  runMigrations(db);
  seedProducts(db);
  return db;
}

/**
 * Drizzle's migrator checks which migrations were applied *before* it opens its
 * transaction. If two instances start on the same file at the same moment, the
 * slower one can try to re-run a migration the faster one just committed and
 * fail with "table already exists". Re-running migrate() is safe (it re-reads
 * the applied list and skips what is done), so a lost race is retried.
 * In production, migrations would run once as a deploy step (`npm run db:migrate`).
 */
function runMigrations(db: DB, attempts = 5): void {
  for (let attempt = 1; ; attempt++) {
    try {
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      return;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const lostRace = /already exists|SQLITE_BUSY|database is locked/i.test(message);
      if (!lostRace || attempt >= attempts) throw error;
    }
  }
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
