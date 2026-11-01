import request from 'supertest';
import { checkout, countRows, createCart, makeTestApp, placeOrders, stockOf, TestContext } from './helpers';

describe('checkout', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = makeTestApp();
  });
  afterEach(() => ctx.close());

  it('places an order whose snapshot survives later product changes', async () => {
    const cartId = await createCart(ctx.app, [
      ['p-jeans', 2],
      ['p-cap', 1],
    ]);
    const res = await checkout(ctx.app, cartId).expect(201);
    expect(res.body).toMatchObject({
      orderNumber: 1,
      status: 'PLACED',
      subtotalPaise: 2 * 129_999 + 29_950,
      discountPaise: 0,
      totalPaise: 2 * 129_999 + 29_950,
    });
    expect(stockOf(ctx.db, 'p-jeans')).toBe(48);

    // Product price changes after the order was placed...
    await request(ctx.app).patch('/admin/products/p-jeans').send({ unitPricePaise: 1 }).expect(200);

    // ...the order still shows what was actually charged.
    const order = await request(ctx.app).get(`/orders/${res.body.id}`).expect(200);
    expect(order.body.items.find((i: { productId: string }) => i.productId === 'p-jeans')).toMatchObject({
      unitPricePaise: 129_999,
      quantity: 2,
      lineTotalPaise: 259_998,
    });
    expect(order.body.totalPaise).toBe(res.body.totalPaise);
  });

  it('does not oversell when many customers check out the last units at once', async () => {
    // p-sneakers-ltd has stock 3. Ten customers each try to buy one.
    const carts = await Promise.all(Array.from({ length: 10 }, () => createCart(ctx.app, [['p-sneakers-ltd', 1]])));
    const results = await Promise.all(carts.map((cartId) => checkout(ctx.app, cartId)));

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    rejected.forEach((r) => expect(r.body.error.code).toBe('INSUFFICIENT_STOCK'));
    expect(stockOf(ctx.db, 'p-sneakers-ltd')).toBe(0);
    expect(countRows(ctx.db, 'orders')).toBe(3);
    // Losing carts stay open so the customer can change them.
    const losingCarts = carts.filter((_, i) => results[i].status === 409);
    for (const cartId of losingCarts) {
      const cart = await request(ctx.app).get(`/carts/${cartId}`).expect(200);
      expect(cart.body.status).toBe('OPEN');
    }
  });

  it('creates exactly one order when the same checkout is retried concurrently with one key', async () => {
    const cartId = await createCart(ctx.app, [['p-hoodie', 2]]);
    const key = 'retry-key-12345';

    const results = await Promise.all(Array.from({ length: 5 }, () => checkout(ctx.app, cartId, { key })));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    results
      .filter((r) => r.status === 200)
      .forEach((r) => expect(r.headers['idempotent-replayed']).toBe('true'));
    expect(countRows(ctx.db, 'orders')).toBe(1);
    expect(stockOf(ctx.db, 'p-hoodie')).toBe(23); // charged once, not five times
    expect(ctx.payments.charges).toHaveLength(1);
  });

  it('allows a cart to be checked out only once, even with different keys', async () => {
    const cartId = await createCart(ctx.app, [['p-tshirt', 1]]);
    const [a, b] = await Promise.all([checkout(ctx.app, cartId), checkout(ctx.app, cartId)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 201 ? a : b;
    expect(loser.body.error).toMatchObject({
      code: 'CART_ALREADY_CHECKED_OUT',
      details: { orderId: winner.body.id },
    });
    expect(countRows(ctx.db, 'orders')).toBe(1);
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const cartId = await createCart(ctx.app, [['p-tshirt', 1]]);
    await checkout(ctx.app, cartId, { key: 'shared-key-0001' }).expect(201);

    const otherCart = await createCart(ctx.app, [['p-cap', 1]]);
    const res = await checkout(ctx.app, otherCart, { key: 'shared-key-0001' }).expect(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(countRows(ctx.db, 'orders')).toBe(1);
  });

  it('requires an idempotency key', async () => {
    const cartId = await createCart(ctx.app, [['p-tshirt', 1]]);
    const res = await request(ctx.app).post(`/carts/${cartId}/checkout`).send({}).expect(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('leaves no trace when payment is declined: stock, coupon and cart untouched', async () => {
    await placeOrders(ctx.app, 5);
    const { body: gen } = await request(ctx.app).post('/admin/coupons').expect(201);
    const couponCode = gen.coupon.code;
    const stockBefore = stockOf(ctx.db, 'p-jeans');
    const ordersBefore = countRows(ctx.db, 'orders');

    const cartId = await createCart(ctx.app, [['p-jeans', 1]]);
    const key = 'decline-then-retry-1';
    const declined = await checkout(ctx.app, cartId, { key, couponCode, declinePayment: true }).expect(402);
    expect(declined.body.error.code).toBe('PAYMENT_DECLINED');

    expect(stockOf(ctx.db, 'p-jeans')).toBe(stockBefore);
    expect(countRows(ctx.db, 'orders')).toBe(ordersBefore);
    const coupons = await request(ctx.app).get('/admin/coupons').expect(200);
    expect(coupons.body.coupons[0].status).toBe('AVAILABLE');
    expect((await request(ctx.app).get(`/carts/${cartId}`)).body.status).toBe('OPEN');

    // A failed attempt is not recorded against the key, so the same retry can now succeed.
    const ok = await checkout(ctx.app, cartId, { key, couponCode }).expect(201);
    expect(ok.body.discount.couponCode).toBe(couponCode);
    expect(stockOf(ctx.db, 'p-jeans')).toBe(stockBefore - 1);
  });

  it('refuses to charge a changed price until the customer accepts it', async () => {
    const cartId = await createCart(ctx.app, [['p-tshirt', 2]]);
    await request(ctx.app).patch('/admin/products/p-tshirt').send({ unitPricePaise: 59_900 }).expect(200);

    const cart = await request(ctx.app).get(`/carts/${cartId}`).expect(200);
    expect(cart.body.items[0]).toMatchObject({ priceSeenPaise: 49_900, unitPricePaise: 59_900, priceChanged: true });
    expect(cart.body.warnings[0].code).toBe('PRICE_CHANGED');

    const key = 'price-change-key-1';
    const res = await checkout(ctx.app, cartId, { key }).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { items: [{ productId: 'p-tshirt', priceSeenPaise: 49_900, currentPricePaise: 59_900 }] },
    });
    // A blind retry with the same key still fails: nothing changed.
    await checkout(ctx.app, cartId, { key }).expect(409);
    expect(countRows(ctx.db, 'orders')).toBe(0);

    await request(ctx.app).post(`/carts/${cartId}/accept-current-prices`).expect(200);
    const ok = await checkout(ctx.app, cartId).expect(201);
    expect(ok.body.totalPaise).toBe(2 * 59_900);
  });

  it('reports every short line and decrements nothing when any line is short', async () => {
    const cartId = await createCart(ctx.app, [
      ['p-tshirt', 2],
      ['p-sneakers-ltd', 2],
      ['p-poster-signed', 1],
    ]);
    // Stock drops after the items were added.
    await request(ctx.app).patch('/admin/products/p-sneakers-ltd').send({ stock: 1 }).expect(200);
    await request(ctx.app).patch('/admin/products/p-poster-signed').send({ stock: 0 }).expect(200);

    const res = await checkout(ctx.app, cartId).expect(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.items).toEqual([
      { productId: 'p-poster-signed', requested: 1, available: 0 },
      { productId: 'p-sneakers-ltd', requested: 2, available: 1 },
    ]);
    expect(stockOf(ctx.db, 'p-tshirt')).toBe(100); // not partially charged
  });

  it('rejects checkout of an empty cart and of a missing cart', async () => {
    const { body } = await request(ctx.app).post('/carts').expect(201);
    expect((await checkout(ctx.app, body.id).expect(422)).body.error.code).toBe('CART_EMPTY');
    expect((await checkout(ctx.app, 'no-such-cart').expect(404)).body.error.code).toBe('CART_NOT_FOUND');
  });
});
