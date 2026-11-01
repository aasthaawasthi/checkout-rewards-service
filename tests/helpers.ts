import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { AppConfig } from '../src/config';
import { DB, openDatabase } from '../src/db/database';
import { createApp } from '../src/http/app';
import { FakePaymentGateway } from '../src/services/payment';

export function tempDbPath(): string {
  return path.join(os.tmpdir(), `crs-test-${randomUUID()}.db`);
}

export function removeDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

export interface TestContext {
  app: ReturnType<typeof createApp>;
  db: DB;
  dbPath: string;
  payments: FakePaymentGateway;
  close: () => void;
}

/** A fresh app on its own SQLite file (a real file, so WAL/locking behave as in production). */
export function makeTestApp(overrides: Partial<AppConfig> = {}, dbPath = tempDbPath()): TestContext {
  const config: AppConfig = { port: 0, dbPath, milestoneN: 5, discountPercentX: 10, ...overrides };
  const db = openDatabase(dbPath);
  const payments = new FakePaymentGateway();
  const app = createApp({ db, config, payments });
  return {
    app,
    db,
    dbPath,
    payments,
    close: () => {
      db.close();
      removeDb(dbPath);
    },
  };
}

export async function createCart(app: TestContext['app'], items: Array<[string, number]>): Promise<string> {
  const res = await request(app).post('/carts').expect(201);
  const cartId: string = res.body.id;
  for (const [productId, quantity] of items) {
    await request(app).post(`/carts/${cartId}/items`).send({ productId, quantity }).expect(201);
  }
  return cartId;
}

export function checkout(
  app: TestContext['app'],
  cartId: string,
  opts: { key?: string; couponCode?: string; declinePayment?: boolean } = {},
) {
  const req = request(app)
    .post(`/carts/${cartId}/checkout`)
    .set('Idempotency-Key', opts.key ?? `key-${randomUUID()}`);
  if (opts.declinePayment) req.set('X-Simulate-Payment', 'decline');
  return req.send(opts.couponCode ? { couponCode: opts.couponCode } : {});
}

/** Places `count` simple orders (1 cap each) and returns their ids. */
export async function placeOrders(app: TestContext['app'], count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const cartId = await createCart(app, [['p-cap', 1]]);
    const res = await checkout(app, cartId).expect(201);
    ids.push(res.body.id);
  }
  return ids;
}

export function stockOf(db: DB, productId: string): number {
  return (db.prepare('SELECT stock FROM products WHERE id = ?').get(productId) as { stock: number }).stock;
}

export function countRows(db: DB, table: 'orders' | 'coupons' | 'idempotency_keys' | 'order_items'): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}
