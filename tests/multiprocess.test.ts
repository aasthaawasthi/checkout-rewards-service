/**
 * The in-process tests above prove the outcome logic, but Node handles those
 * requests on one thread, so they cannot prove the locking is real.
 *
 * This test starts TWO separate server processes on the SAME database file and
 * sends overlapping requests to both. Here the only thing preventing
 * overselling and double redemption is the database transaction, exactly as
 * it would be with several app instances in production.
 *
 * Requires `npm run build` first (npm test does this).
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { removeDb, tempDbPath } from './helpers';

const SERVER = path.join(__dirname, '..', 'dist', 'server.js');

function startServer(port: number, dbPath: string, env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error(`server on ${port} did not start`)), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(`server on ${port} exited with ${code}`));
    });
  });
}

async function call(base: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const describeIfBuilt = fs.existsSync(SERVER) ? describe : describe.skip;

describeIfBuilt('two service instances sharing one database', () => {
  const dbPath = tempDbPath();
  const portA = 41000 + Math.floor(Math.random() * 1000);
  const portB = portA + 1;
  const A = `http://127.0.0.1:${portA}`;
  const B = `http://127.0.0.1:${portB}`;
  let servers: ChildProcess[] = [];

  beforeAll(async () => {
    const env = { ORDER_MILESTONE_N: '1', DISCOUNT_PERCENT_X: '20' };
    servers = await Promise.all([startServer(portA, dbPath, env), startServer(portB, dbPath, env)]);
  });

  afterAll(() => {
    servers.forEach((s) => s.kill());
    removeDb(dbPath);
  });

  async function cartWith(base: string, productId: string, quantity: number): Promise<string> {
    const cart = await call(base, 'POST', '/carts');
    const add = await call(base, 'POST', `/carts/${cart.body.id}/items`, { productId, quantity });
    expect(add.status).toBe(201);
    return cart.body.id;
  }

  it('never oversells when checkouts hit both instances at once', async () => {
    const carts = await Promise.all(Array.from({ length: 12 }, () => cartWith(A, 'p-sneakers-ltd', 1)));
    const results = await Promise.all(
      carts.map((cartId, i) =>
        call(i % 2 ? A : B, 'POST', `/carts/${cartId}/checkout`, {}, { 'Idempotency-Key': `mp-${cartId}` }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);

    const product = await call(B, 'GET', '/products/p-sneakers-ltd');
    expect(product.body.availableStock).toBe(0);
    // Order numbers are unique and gap-free across both instances.
    expect(created.map((r) => r.body.orderNumber).sort()).toEqual([1, 2, 3]);
  });

  it('lets a retried checkout land on the other instance without creating a second order', async () => {
    const cartId = await cartWith(A, 'p-cap', 1);
    const key = `mp-retry-${cartId}`;
    const results = await Promise.all(
      [A, B, A, B].map((base) => call(base, 'POST', `/carts/${cartId}/checkout`, {}, { 'Idempotency-Key': key })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  });

  it('redeems one coupon once across instances and generates it once', async () => {
    // n = 1, so every order is a milestone; generate concurrently on both instances.
    const before = await call(A, 'GET', '/admin/report');
    const pending = before.body.milestones.awaitingGeneration;
    const gens = await Promise.all(
      Array.from({ length: pending + 4 }, (_, i) => call(i % 2 ? A : B, 'POST', '/admin/coupons')),
    );
    expect(gens.filter((g) => g.status === 201)).toHaveLength(pending);
    const milestones = gens.filter((g) => g.status === 201).map((g) => g.body.coupon.milestone);
    expect(new Set(milestones).size).toBe(pending);

    const code = gens.find((g) => g.status === 201)!.body.coupon.code;
    const carts = await Promise.all(Array.from({ length: 6 }, () => cartWith(B, 'p-tshirt', 1)));
    const results = await Promise.all(
      carts.map((cartId, i) =>
        call(i % 2 ? A : B, 'POST', `/carts/${cartId}/checkout`, { couponCode: code }, { 'Idempotency-Key': `mpc-${cartId}` }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'COUPON_ALREADY_REDEEMED')).toBe(true);

    const report = await call(B, 'GET', '/admin/report');
    expect(report.body.ordersWithCoupon).toBe(1);
    expect(report.body.netRevenuePaise).toBe(report.body.grossRevenuePaise - report.body.totalDiscountPaise);
  });
});
