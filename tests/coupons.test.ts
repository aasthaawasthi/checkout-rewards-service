import request from 'supertest';
import { checkout, countRows, createCart, makeTestApp, placeOrders, tempDbPath, removeDb, TestContext } from './helpers';
import { openDatabase } from '../src/db/database';
import { createApp } from '../src/api/app';

describe('milestone coupons', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = makeTestApp({ milestoneN: 3, discountPercentX: 10 });
  });
  afterEach(() => ctx.close());

  it('generates a coupon only once the milestone is reached, and only once per milestone', async () => {
    await placeOrders(ctx.app, 2);
    const early = await request(ctx.app).post('/admin/coupons').expect(409);
    expect(early.body.error).toMatchObject({
      code: 'NO_ELIGIBLE_MILESTONE',
      details: { placedOrders: 2, nextMilestoneAtOrder: 3 },
    });

    await placeOrders(ctx.app, 1);
    const gen = await request(ctx.app).post('/admin/coupons').expect(201);
    expect(gen.body.coupon).toMatchObject({ milestone: 1, unlockedAtOrder: 3, discountPercent: 10, status: 'AVAILABLE' });

    await request(ctx.app).post('/admin/coupons').expect(409);
    expect(countRows(ctx.db, 'coupons')).toBe(1);
  });

  it('catches up on missed milestones one coupon per call', async () => {
    await placeOrders(ctx.app, 7); // milestones 1 (order 3) and 2 (order 6) reached
    const first = await request(ctx.app).post('/admin/coupons').expect(201);
    expect(first.body).toMatchObject({ coupon: { milestone: 1 }, remainingEligibleMilestones: 1 });
    const second = await request(ctx.app).post('/admin/coupons').expect(201);
    expect(second.body).toMatchObject({ coupon: { milestone: 2 }, remainingEligibleMilestones: 0 });
    await request(ctx.app).post('/admin/coupons').expect(409);
  });

  it('generates exactly one coupon when admins request it concurrently', async () => {
    await placeOrders(ctx.app, 3);
    const results = await Promise.all(Array.from({ length: 6 }, () => request(ctx.app).post('/admin/coupons')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(countRows(ctx.db, 'coupons')).toBe(1);
  });

  it('lets only one of two concurrent checkouts redeem the same coupon', async () => {
    await placeOrders(ctx.app, 3);
    const code = (await request(ctx.app).post('/admin/coupons').expect(201)).body.coupon.code;

    const cartA = await createCart(ctx.app, [['p-jeans', 1]]);
    const cartB = await createCart(ctx.app, [['p-hoodie', 1]]);
    const [a, b] = await Promise.all([
      checkout(ctx.app, cartA, { couponCode: code }),
      checkout(ctx.app, cartB, { couponCode: code }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('COUPON_ALREADY_REDEEMED');

    const report = (await request(ctx.app).get('/admin/report').expect(200)).body;
    expect(report.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });
    expect(report.ordersWithCoupon).toBe(1);
    // The losing cart is still open and can check out without the coupon.
    const loserCart = a.status === 409 ? cartA : cartB;
    await checkout(ctx.app, loserCart).expect(201);
  });

  it('accepts coupon codes case-insensitively and applies the rounded-down discount', async () => {
    await placeOrders(ctx.app, 3);
    const code: string = (await request(ctx.app).post('/admin/coupons').expect(201)).body.coupon.code;
    const cartId = await createCart(ctx.app, [['p-jeans', 1]]); // 129_999 paise
    const res = await checkout(ctx.app, cartId, { couponCode: `  ${code.toLowerCase()} ` }).expect(201);
    expect(res.body).toMatchObject({
      subtotalPaise: 129_999,
      discountPaise: 12_999, // floor(12_999.9)
      totalPaise: 117_000,
      discount: { couponCode: code, percent: 10 },
    });
  });

  it('rejects unknown coupons without consuming anything', async () => {
    const cartId = await createCart(ctx.app, [['p-cap', 1]]);
    const res = await checkout(ctx.app, cartId, { couponCode: 'NOT-A-CODE' }).expect(422);
    expect(res.body.error.code).toBe('COUPON_NOT_FOUND');
    expect(countRows(ctx.db, 'orders')).toBe(0);
  });
});

describe('coupon value is fixed when generated', () => {
  it('keeps the original percent even if x is reconfigured later, and 100% never goes negative', async () => {
    const dbPath = tempDbPath();
    try {
      const db1 = openDatabase(dbPath);
      const app1 = createApp({ db: db1, config: { port: 0, dbPath, milestoneN: 1, discountPercentX: 10 } });
      await placeOrders(app1, 1);
      const tenPercent = (await request(app1).post('/admin/coupons').expect(201)).body.coupon.code;
      db1.$client.close();

      // Restart with x = 100.
      const db2 = openDatabase(dbPath);
      const app2 = createApp({ db: db2, config: { port: 0, dbPath, milestoneN: 1, discountPercentX: 100 } });
      const cartId = await createCart(app2, [['p-tshirt', 1]]);
      const res = await checkout(app2, cartId, { couponCode: tenPercent }).expect(201);
      expect(res.body.discount.percent).toBe(10);
      expect(res.body.discountPaise).toBe(4_990);

      const free = (await request(app2).post('/admin/coupons').expect(201)).body.coupon;
      expect(free.discountPercent).toBe(100);
      const cart2 = await createCart(app2, [['p-cap', 1]]);
      const freeOrder = await checkout(app2, cart2, { couponCode: free.code }).expect(201);
      expect(freeOrder.body.totalPaise).toBe(0);
      db2.$client.close();
    } finally {
      removeDb(dbPath);
    }
  });
});
