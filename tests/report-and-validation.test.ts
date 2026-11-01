import request from 'supertest';
import { checkout, createCart, makeTestApp, placeOrders, TestContext } from './helpers';

describe('admin report', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = makeTestApp({ milestoneN: 2, discountPercentX: 15 });
  });
  afterEach(() => ctx.close());

  it('reconciles with the orders and coupons the API returns', async () => {
    const orderIds = await placeOrders(ctx.app, 2);
    const code = (await request(ctx.app).post('/admin/coupons').expect(201)).body.coupon.code;
    const cartId = await createCart(ctx.app, [
      ['p-jeans', 1],
      ['p-tshirt', 3],
    ]);
    orderIds.push((await checkout(ctx.app, cartId, { couponCode: code }).expect(201)).body.id);
    // A failed checkout must not appear anywhere in the report.
    const failing = await createCart(ctx.app, [['p-poster-signed', 1]]);
    await checkout(ctx.app, failing, { declinePayment: true }).expect(402);

    const orders = await Promise.all(orderIds.map((id) => request(ctx.app).get(`/orders/${id}`).expect(200)));
    const report = (await request(ctx.app).get('/admin/report').expect(200)).body;

    const sumOf = (f: (o: any) => number) => orders.reduce((acc, o) => acc + f(o.body), 0);
    expect(report.totalOrders).toBe(3);
    expect(report.grossRevenuePaise).toBe(sumOf((o) => o.subtotalPaise));
    expect(report.totalDiscountPaise).toBe(sumOf((o) => o.discountPaise));
    expect(report.netRevenuePaise).toBe(sumOf((o) => o.totalPaise));
    expect(report.netRevenuePaise).toBe(report.grossRevenuePaise - report.totalDiscountPaise);

    const qty = (id: string) => report.purchasedByProduct.find((p: any) => p.productId === id)?.quantity;
    expect(qty('p-cap')).toBe(2);
    expect(qty('p-jeans')).toBe(1);
    expect(qty('p-tshirt')).toBe(3);
    expect(qty('p-poster-signed')).toBeUndefined();
    expect(report.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });
    expect(report.milestones).toMatchObject({ reached: 1, rewarded: 1, awaitingGeneration: 0, nextMilestoneAtOrder: 4 });
  });

  it('does not change state when requested repeatedly', async () => {
    await placeOrders(ctx.app, 2);
    const snapshot = () =>
      JSON.stringify(
        ['products', 'carts', 'orders', 'coupons', 'idempotency_keys'].map((t) =>
          ctx.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(),
        ),
      );
    const before = snapshot();
    const first = (await request(ctx.app).get('/admin/report')).body;
    const second = (await request(ctx.app).get('/admin/report')).body;
    expect(second).toEqual(first);
    expect(snapshot()).toBe(before);
    // Reaching a milestone does not auto-generate coupons; only the admin call does.
    expect(first.coupons.generated).toBe(0);
    expect(first.milestones.awaitingGeneration).toBe(1);
  });
});

describe('input validation and error contract', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.close());

  it.each([
    [{ productId: 'p-cap', quantity: 0 }],
    [{ productId: 'p-cap', quantity: -1 }],
    [{ productId: 'p-cap', quantity: 1.5 }],
    [{ productId: 'p-cap', quantity: '2' }],
    [{ productId: 'p-cap', quantity: 1001 }],
    [{ productId: 'p-cap' }],
    [{ productId: 'p-cap', quantity: 1, price: 1 }],
  ])('rejects invalid item %j without changing the cart', async (body) => {
    const cartId = await createCart(ctx.app, []);
    const res = await request(ctx.app).post(`/carts/${cartId}/items`).send(body).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(ctx.app).get(`/carts/${cartId}`)).body.items).toEqual([]);
  });

  it('rejects unknown products and over-stock quantities with specific codes', async () => {
    const cartId = await createCart(ctx.app, []);
    const unknown = await request(ctx.app).post(`/carts/${cartId}/items`).send({ productId: 'p-nope', quantity: 1 });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('PRODUCT_NOT_FOUND');

    const tooMany = await request(ctx.app).post(`/carts/${cartId}/items`).send({ productId: 'p-poster-signed', quantity: 2 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { items: [{ productId: 'p-poster-signed', requested: 2, available: 1 }] },
    });
  });

  it('makes a retried add-item safe (no doubled quantity)', async () => {
    const cartId = await createCart(ctx.app, [['p-cap', 2]]);
    const retry = await request(ctx.app).post(`/carts/${cartId}/items`).send({ productId: 'p-cap', quantity: 2 });
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('ITEM_ALREADY_IN_CART');
    expect((await request(ctx.app).get(`/carts/${cartId}`)).body.items[0].quantity).toBe(2);
  });

  it('supports update and remove, and returns useful totals', async () => {
    const cartId = await createCart(ctx.app, [
      ['p-cap', 1],
      ['p-tshirt', 1],
    ]);
    await request(ctx.app).patch(`/carts/${cartId}/items/p-cap`).send({ quantity: 3 }).expect(200);
    const res = await request(ctx.app).delete(`/carts/${cartId}/items/p-tshirt`).expect(200);
    expect(res.body).toMatchObject({ itemCount: 3, subtotalPaise: 89_850, subtotalDisplay: '₹898.50' });
    await request(ctx.app).delete(`/carts/${cartId}/items/p-tshirt`).expect(404);
  });

  it('freezes a cart after checkout', async () => {
    const cartId = await createCart(ctx.app, [['p-cap', 1]]);
    await checkout(ctx.app, cartId).expect(201);
    const res = await request(ctx.app).patch(`/carts/${cartId}/items/p-cap`).send({ quantity: 5 }).expect(409);
    expect(res.body.error.code).toBe('CART_NOT_OPEN');
  });

  it('returns the error envelope for malformed JSON and unknown routes', async () => {
    const cartId = await createCart(ctx.app, []);
    const bad = await request(ctx.app)
      .post(`/carts/${cartId}/items`)
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const missing = await request(ctx.app).get('/nope').expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});
