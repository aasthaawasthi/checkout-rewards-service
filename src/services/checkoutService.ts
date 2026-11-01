import { createHash, randomUUID } from 'crypto';
import { DB } from '../db/database';
import { AppError, conflict, notFound, unprocessable } from '../domain/errors';
import { lineTotal, percentDiscount, sum } from '../domain/money';
import { CartRow } from './cartService';
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

interface LineRow {
  product_id: string;
  quantity: number;
  price_seen_paise: number;
  name: string;
  price_paise: number;
  stock: number;
}

interface CouponRow {
  code: string;
  discount_percent: number;
  status: 'AVAILABLE' | 'REDEEMED';
}

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Checkout: the one operation that must be atomic.
 *
 * Everything happens inside a single IMMEDIATE transaction. IMMEDIATE takes
 * SQLite's write lock at BEGIN, so checkouts (and any other writers, in this
 * process or another process using the same file) are serialised. Every
 * check below therefore sees data that cannot change until we commit.
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

    return this.db
      .transaction((): CheckoutOutcome => {
        // 1. Idempotency ------------------------------------------------------
        const previous = this.db
          .prepare('SELECT request_hash, order_id FROM idempotency_keys WHERE key = ?')
          .get(input.idempotencyKey) as { request_hash: string; order_id: string } | undefined;
        if (previous) {
          if (previous.request_hash !== requestHash) {
            throw unprocessable(
              'IDEMPOTENCY_KEY_REUSED',
              'This Idempotency-Key was already used for a different checkout request',
              { idempotencyKey: input.idempotencyKey },
            );
          }
          return { orderId: previous.order_id, replayed: true };
        }

        // 2. Cart -------------------------------------------------------------
        const cart = this.db.prepare('SELECT * FROM carts WHERE id = ?').get(input.cartId) as CartRow | undefined;
        if (!cart) throw notFound('CART_NOT_FOUND', `Cart ${input.cartId} does not exist`, { cartId: input.cartId });
        if (cart.status !== 'OPEN') {
          const existing = this.db.prepare('SELECT id FROM orders WHERE cart_id = ?').get(cart.id) as
            | { id: string }
            | undefined;
          throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out', {
            cartId: cart.id,
            orderId: existing?.id ?? null,
          });
        }

        const lines = this.db
          .prepare(
            `SELECT ci.product_id, ci.quantity, ci.price_seen_paise, p.name, p.price_paise, p.stock
               FROM cart_items ci JOIN products p ON p.id = ci.product_id
              WHERE ci.cart_id = ?
              ORDER BY ci.product_id`,
          )
          .all(cart.id) as LineRow[];
        if (lines.length === 0) throw unprocessable('CART_EMPTY', 'Cannot check out an empty cart', { cartId: cart.id });

        // 3. Prices -----------------------------------------------------------
        const priceChanges = lines
          .filter((l) => l.price_paise !== l.price_seen_paise)
          .map((l) => ({ productId: l.product_id, priceSeenPaise: l.price_seen_paise, currentPricePaise: l.price_paise }));
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
          .map((l) => ({ productId: l.product_id, requested: l.quantity, available: l.stock }));
        if (shortages.length > 0) {
          throw conflict('INSUFFICIENT_STOCK', 'Not enough stock for some items', { items: shortages });
        }

        // 5. Coupon -----------------------------------------------------------
        let coupon: CouponRow | undefined;
        if (couponCode) {
          coupon = this.db
            .prepare('SELECT code, discount_percent, status FROM coupons WHERE code = ?')
            .get(couponCode) as CouponRow | undefined;
          if (!coupon) throw unprocessable('COUPON_NOT_FOUND', `Coupon ${couponCode} does not exist`, { couponCode });
          if (coupon.status !== 'AVAILABLE') {
            throw conflict('COUPON_ALREADY_REDEEMED', `Coupon ${couponCode} has already been redeemed`, { couponCode });
          }
        }

        // 6. Totals -----------------------------------------------------------
        const orderLines = lines.map((l) => ({
          productId: l.product_id,
          name: l.name,
          unitPricePaise: l.price_paise,
          quantity: l.quantity,
          lineTotalPaise: lineTotal(l.price_paise, l.quantity),
        }));
        const subtotalPaise = sum(orderLines.map((l) => l.lineTotalPaise));
        const discountPaise = coupon ? percentDiscount(subtotalPaise, coupon.discount_percent) : 0;
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

        // Conditional decrement: the database refuses to go below zero even if a
        // future code path skipped step 4. (The CHECK (stock >= 0) is a second net.)
        const decrement = this.db.prepare(
          'UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?',
        );
        for (const l of orderLines) {
          if (decrement.run(l.quantity, now, l.productId, l.quantity).changes !== 1) {
            throw conflict('INSUFFICIENT_STOCK', 'Not enough stock for some items', {
              items: [{ productId: l.productId, requested: l.quantity }],
            });
          }
        }

        const { next } = this.db
          .prepare('SELECT COALESCE(MAX(order_number), 0) + 1 AS next FROM orders')
          .get() as { next: number };

        this.db
          .prepare(
            `INSERT INTO orders (id, order_number, cart_id, status, subtotal_paise, discount_paise, total_paise,
                                 coupon_code, discount_percent, payment_reference, created_at)
             VALUES (?, ?, ?, 'PLACED', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            orderId,
            next,
            cart.id,
            subtotalPaise,
            discountPaise,
            totalPaise,
            coupon?.code ?? null,
            coupon?.discount_percent ?? null,
            payment.reference,
            now,
          );

        const insertItem = this.db.prepare(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const l of orderLines) {
          insertItem.run(orderId, l.productId, l.name, l.unitPricePaise, l.quantity, l.lineTotalPaise);
        }

        if (coupon) {
          // Conditional redeem: only one transaction can flip AVAILABLE -> REDEEMED.
          const redeemed = this.db
            .prepare(
              `UPDATE coupons SET status = 'REDEEMED', redeemed_order_id = ?, redeemed_at = ?
                WHERE code = ? AND status = 'AVAILABLE'`,
            )
            .run(orderId, now, coupon.code);
          if (redeemed.changes !== 1) {
            throw conflict('COUPON_ALREADY_REDEEMED', `Coupon ${coupon.code} has already been redeemed`, {
              couponCode: coupon.code,
            });
          }
        }

        const closed = this.db
          .prepare(`UPDATE carts SET status = 'CHECKED_OUT', updated_at = ? WHERE id = ? AND status = 'OPEN'`)
          .run(now, cart.id);
        if (closed.changes !== 1) {
          throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out', { cartId: cart.id });
        }

        this.db
          .prepare(
            `INSERT INTO idempotency_keys (key, cart_id, request_hash, order_id, created_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.idempotencyKey, cart.id, requestHash, orderId, now);

        return { orderId, replayed: false };
      })
      .immediate();
  }
}
