import { and, asc, eq, gte, max, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { DB } from '../db/database';
import { cartItems, carts, coupons, idempotencyKeys, orderItems, orders, products } from '../db/schema';
import { AppError, conflict, notFound, unprocessable } from '../domain/errors';
import { lineTotal, percentDiscount, sum } from '../domain/money';
import { PaymentGateway } from './payment';

export interface CheckoutInput {
  cartId: string;
  couponCode?: string;
  idempotencyKey: string;
  simulatePaymentDecline?: boolean;
}

export interface CheckoutOutcome {
  orderId: string;
  /** true when this request was a retry and the original order is returned. */
  replayed: boolean;
}

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Checkout: the one operation that must be atomic.
 *
 * Everything happens inside a single IMMEDIATE transaction. IMMEDIATE takes
 * SQLite's write lock at BEGIN, so checkouts (and any other writers, in this
 * process or another process using the same file) are serialised and wait for
 * each other instead of failing. Every check below sees data that cannot change
 * until we commit.
 *
 * Failure at any step throws, and the transaction rolls back: stock, coupon,
 * cart status and idempotency record are all left exactly as they were. That
 * is what makes "a coupon must not be consumed by a checkout that fails" and
 * "no overselling" hold together.
 *
 * Steps:
 *  1. Idempotency: same key + same request -> return the original order.
 *     Same key + different request -> 422.
 *  2. Cart must exist, be OPEN and non-empty. Already checked out -> 409 with the order id.
 *  3. Prices must equal the prices the customer last saw (else 409 PRICE_CHANGED).
 *  4. Stock must cover every line (else 409 INSUFFICIENT_STOCK listing every short line).
 *  5. Coupon (optional) must exist and be AVAILABLE.
 *  6. Totals computed in integer paise.
 *  7. Payment (fake) is charged; a decline aborts everything.
 *  8. Writes: decrement stock (conditional), insert order + item snapshot,
 *     redeem coupon (conditional), close cart, record idempotency key.
 */
export class CheckoutService {
  constructor(
    private readonly db: DB,
    private readonly payments: PaymentGateway,
  ) {}

  checkout(input: CheckoutInput): CheckoutOutcome {
    const couponCode = input.couponCode ? normalizeCouponCode(input.couponCode) : null;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ cartId: input.cartId, couponCode }))
      .digest('hex');

    return this.db.transaction(
      (tx): CheckoutOutcome => {
        // 1. Idempotency ------------------------------------------------------
        const previous = tx
          .select({ requestHash: idempotencyKeys.requestHash, orderId: idempotencyKeys.orderId })
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, input.idempotencyKey))
          .get();
        if (previous) {
          if (previous.requestHash !== requestHash) {
            throw unprocessable(
              'IDEMPOTENCY_KEY_REUSED',
              'This Idempotency-Key was already used for a different checkout request',
              { idempotencyKey: input.idempotencyKey },
            );
          }
          return { orderId: previous.orderId, replayed: true };
        }

        // 2. Cart -------------------------------------------------------------
        const cart = tx.select().from(carts).where(eq(carts.id, input.cartId)).get();
        if (!cart) throw notFound('CART_NOT_FOUND', `Cart ${input.cartId} does not exist`, { cartId: input.cartId });
        if (cart.status !== 'OPEN') {
          const existing = tx.select({ id: orders.id }).from(orders).where(eq(orders.cartId, cart.id)).get();
          throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out', {
            cartId: cart.id,
            orderId: existing?.id ?? null,
          });
        }

        const lines = tx
          .select({
            productId: cartItems.productId,
            quantity: cartItems.quantity,
            priceSeenPaise: cartItems.priceSeenPaise,
            name: products.name,
            pricePaise: products.pricePaise,
            stock: products.stock,
          })
          .from(cartItems)
          .innerJoin(products, eq(products.id, cartItems.productId))
          .where(eq(cartItems.cartId, cart.id))
          .orderBy(asc(cartItems.productId))
          .all();
        if (lines.length === 0) throw unprocessable('CART_EMPTY', 'Cannot check out an empty cart', { cartId: cart.id });

        // 3. Prices -----------------------------------------------------------
        const priceChanges = lines
          .filter((l) => l.pricePaise !== l.priceSeenPaise)
          .map((l) => ({ productId: l.productId, priceSeenPaise: l.priceSeenPaise, currentPricePaise: l.pricePaise }));
        if (priceChanges.length > 0) {
          throw conflict(
            'PRICE_CHANGED',
            'Some prices changed since they were added to the cart. Review the cart and accept the current prices before checking out.',
            { items: priceChanges, acceptPricesUrl: `/carts/${cart.id}/accept-current-prices` },
          );
        }

        // 4. Stock (report every short line, not just the first) --------------
        const shortages = lines
          .filter((l) => l.stock < l.quantity)
          .map((l) => ({ productId: l.productId, requested: l.quantity, available: l.stock }));
        if (shortages.length > 0) {
          throw conflict('INSUFFICIENT_STOCK', 'Not enough stock for some items', { items: shortages });
        }

        // 5. Coupon -----------------------------------------------------------
        const coupon = couponCode
          ? tx
              .select({ code: coupons.code, discountPercent: coupons.discountPercent, status: coupons.status })
              .from(coupons)
              .where(eq(coupons.code, couponCode))
              .get()
          : undefined;
        if (couponCode) {
          if (!coupon) throw unprocessable('COUPON_NOT_FOUND', `Coupon ${couponCode} does not exist`, { couponCode });
          if (coupon.status !== 'AVAILABLE') {
            throw conflict('COUPON_ALREADY_REDEEMED', `Coupon ${couponCode} has already been redeemed`, { couponCode });
          }
        }

        // 6. Totals -----------------------------------------------------------
        const orderLines = lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          unitPricePaise: l.pricePaise,
          quantity: l.quantity,
          lineTotalPaise: lineTotal(l.pricePaise, l.quantity),
        }));
        const subtotalPaise = sum(orderLines.map((l) => l.lineTotalPaise));
        const discountPaise = coupon ? percentDiscount(subtotalPaise, coupon.discountPercent) : 0;
        const totalPaise = subtotalPaise - discountPaise;

        // 7. Payment ----------------------------------------------------------
        const orderId = randomUUID();
        const payment = this.payments.charge({
          orderId,
          amountPaise: totalPaise,
          idempotencyKey: input.idempotencyKey,
          simulateDecline: input.simulatePaymentDecline,
        });
        if (!payment.ok) {
          throw new AppError(402, 'PAYMENT_DECLINED', payment.reason, { cartId: cart.id });
        }

        // 8. Writes -----------------------------------------------------------
        const now = new Date().toISOString();

        // Conditional, atomic decrement (stock = stock - q WHERE stock >= q): the
        // database refuses to go below zero even if a future code path skipped
        // step 4. The CHECK (stock >= 0) constraint is a second net.
        for (const l of orderLines) {
          const result = tx
            .update(products)
            .set({ stock: sql`${products.stock} - ${l.quantity}`, updatedAt: now })
            .where(and(eq(products.id, l.productId), gte(products.stock, l.quantity)))
            .run();
          if (result.changes !== 1) {
            throw conflict('INSUFFICIENT_STOCK', 'Not enough stock for some items', {
              items: [{ productId: l.productId, requested: l.quantity }],
            });
          }
        }

        const { lastNumber } = tx.select({ lastNumber: max(orders.orderNumber) }).from(orders).get()!;

        tx.insert(orders)
          .values({
            id: orderId,
            orderNumber: (lastNumber ?? 0) + 1,
            cartId: cart.id,
            status: 'PLACED',
            subtotalPaise,
            discountPaise,
            totalPaise,
            couponCode: coupon?.code ?? null,
            discountPercent: coupon?.discountPercent ?? null,
            paymentReference: payment.reference,
            createdAt: now,
          })
          .run();

        tx.insert(orderItems)
          .values(
            orderLines.map((l) => ({
              orderId,
              productId: l.productId,
              productName: l.name,
              unitPricePaise: l.unitPricePaise,
              quantity: l.quantity,
              lineTotalPaise: l.lineTotalPaise,
            })),
          )
          .run();

        if (coupon) {
          // Conditional redeem: only one transaction can flip AVAILABLE -> REDEEMED.
          const redeemed = tx
            .update(coupons)
            .set({ status: 'REDEEMED', redeemedOrderId: orderId, redeemedAt: now })
            .where(and(eq(coupons.code, coupon.code), eq(coupons.status, 'AVAILABLE')))
            .run();
          if (redeemed.changes !== 1) {
            throw conflict('COUPON_ALREADY_REDEEMED', `Coupon ${coupon.code} has already been redeemed`, {
              couponCode: coupon.code,
            });
          }
        }

        const closed = tx
          .update(carts)
          .set({ status: 'CHECKED_OUT', updatedAt: now })
          .where(and(eq(carts.id, cart.id), eq(carts.status, 'OPEN')))
          .run();
        if (closed.changes !== 1) {
          throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out', { cartId: cart.id });
        }

        tx.insert(idempotencyKeys)
          .values({ key: input.idempotencyKey, cartId: cart.id, requestHash, orderId, createdAt: now })
          .run();

        return { orderId, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }
}
