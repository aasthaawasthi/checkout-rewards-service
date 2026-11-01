import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SEED_PRODUCTS } from './seed';

export type DB = Database.Database;

/**
 * Schema.
 *
 * The invariants that matter most are enforced by the database itself, not
 * only by application code, so they hold even if a code path forgets a check
 * or two processes race:
 *  - products.stock >= 0                  -> inventory can never go negative (no overselling)
 *  - orders.cart_id UNIQUE                -> a cart produces at most one order
 *  - orders.order_number UNIQUE           -> milestone counting is unambiguous
 *  - coupons.milestone UNIQUE             -> at most one coupon per milestone
 *  - coupons.redeemed_order_id UNIQUE     -> a coupon is attached to at most one order
 *  - idempotency_keys.key PRIMARY KEY     -> a key maps to exactly one outcome
 *  - all money columns are INTEGER paise  -> no floating-point money anywhere
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0),
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS carts (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id          TEXT    NOT NULL REFERENCES carts(id),
  product_id       TEXT    NOT NULL REFERENCES products(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  -- The unit price the customer was last shown for this line. Checkout refuses
  -- to charge a different price without the customer seeing it first.
  price_seen_paise INTEGER NOT NULL CHECK (price_seen_paise >= 0),
  added_at         TEXT    NOT NULL,
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  order_number      INTEGER NOT NULL UNIQUE,
  cart_id           TEXT    NOT NULL UNIQUE REFERENCES carts(id),
  status            TEXT    NOT NULL CHECK (status IN ('PLACED')),
  subtotal_paise    INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise    INTEGER NOT NULL CHECK (discount_paise >= 0),
  total_paise       INTEGER NOT NULL CHECK (total_paise >= 0),
  coupon_code       TEXT,
  discount_percent  INTEGER,
  payment_reference TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  CHECK (total_paise = subtotal_paise - discount_paise)
);

-- Snapshot of what was bought, so an order stays explainable after products change.
CREATE TABLE IF NOT EXISTS order_items (
  order_id         TEXT    NOT NULL REFERENCES orders(id),
  product_id       TEXT    NOT NULL,
  product_name     TEXT    NOT NULL,
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  line_total_paise INTEGER NOT NULL CHECK (line_total_paise >= 0),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code              TEXT PRIMARY KEY,
  milestone         INTEGER NOT NULL UNIQUE CHECK (milestone >= 1),
  -- Order count that unlocked this coupon (milestone * n at generation time).
  unlocked_at_order INTEGER NOT NULL,
  discount_percent  INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  status            TEXT    NOT NULL CHECK (status IN ('AVAILABLE', 'REDEEMED')),
  generated_at      TEXT    NOT NULL,
  redeemed_order_id TEXT UNIQUE REFERENCES orders(id),
  redeemed_at       TEXT,
  CHECK ((status = 'REDEEMED') = (redeemed_order_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  cart_id      TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
`;

/**
 * Opens (or creates) the SQLite database, applies the schema and seeds products.
 *
 * WAL mode lets readers proceed while one writer holds the write lock, and
 * busy_timeout makes a second writer (another request or another process)
 * wait for the lock instead of failing immediately.
 */
export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // Schema + seed in one IMMEDIATE transaction so two processes starting on
  // the same file at the same time cannot interleave.
  db.transaction(() => {
    db.exec(SCHEMA);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO products (id, name, price_paise, stock, updated_at)
       VALUES (@id, @name, @pricePaise, @stock, @now)`,
    );
    const now = new Date().toISOString();
    for (const p of SEED_PRODUCTS) insert.run({ ...p, now });
  }).immediate();

  return db;
}
