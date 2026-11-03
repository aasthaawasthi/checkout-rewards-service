/**
 * Database schema (Drizzle ORM). This file is the single source of truth:
 * `npm run db:generate` turns changes here into a SQL migration in /drizzle,
 * and the service applies pending migrations on startup.
 *
 * The most important invariants are enforced by the database itself, not only
 * by application code, so they hold even if a code path forgets a check or
 * two processes race:
 *  - products.stock >= 0                  -> inventory can never go negative (no overselling)
 *  - orders.cart_id UNIQUE                -> a cart produces at most one order
 *  - orders.order_number UNIQUE           -> milestone counting is unambiguous
 *  - coupons.milestone UNIQUE             -> at most one coupon per milestone
 *  - coupons.redeemed_order_id UNIQUE     -> a coupon is attached to at most one order
 *  - idempotency_keys.key PRIMARY KEY     -> a key maps to exactly one outcome
 *  - all money columns are INTEGER paise  -> no floating-point money anywhere
 *
 * (`sql` below appears only inside CHECK constraint definitions.)
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    pricePaise: integer('price_paise').notNull(),
    stock: integer('stock').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('products_price_non_negative', sql`${t.pricePaise} >= 0`),
    check('products_stock_non_negative', sql`${t.stock} >= 0`),
  ],
);

export const carts = sqliteTable(
  'carts',
  {
    id: text('id').primaryKey(),
    status: text('status', { enum: ['OPEN', 'CHECKED_OUT'] }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [check('carts_status_valid', sql`${t.status} IN ('OPEN', 'CHECKED_OUT')`)],
);

export const cartItems = sqliteTable(
  'cart_items',
  {
    cartId: text('cart_id')
      .notNull()
      .references(() => carts.id),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    quantity: integer('quantity').notNull(),
    // The unit price the customer was last shown for this line. Checkout refuses
    // to charge a different price without the customer accepting it first.
    priceSeenPaise: integer('price_seen_paise').notNull(),
    addedAt: text('added_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cartId, t.productId] }),
    check('cart_items_quantity_positive', sql`${t.quantity} > 0`),
    check('cart_items_price_seen_non_negative', sql`${t.priceSeenPaise} >= 0`),
  ],
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    orderNumber: integer('order_number').notNull().unique(),
    cartId: text('cart_id')
      .notNull()
      .unique()
      .references(() => carts.id),
    status: text('status', { enum: ['PLACED'] }).notNull(),
    subtotalPaise: integer('subtotal_paise').notNull(),
    discountPaise: integer('discount_paise').notNull(),
    totalPaise: integer('total_paise').notNull(),
    couponCode: text('coupon_code'),
    discountPercent: integer('discount_percent'),
    paymentReference: text('payment_reference').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('orders_status_valid', sql`${t.status} IN ('PLACED')`),
    check('orders_subtotal_non_negative', sql`${t.subtotalPaise} >= 0`),
    check('orders_discount_non_negative', sql`${t.discountPaise} >= 0`),
    check('orders_total_non_negative', sql`${t.totalPaise} >= 0`),
    check('orders_total_consistent', sql`${t.totalPaise} = ${t.subtotalPaise} - ${t.discountPaise}`),
  ],
);

// Snapshot of what was bought, so an order stays explainable after products change.
export const orderItems = sqliteTable(
  'order_items',
  {
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    productId: text('product_id').notNull(),
    productName: text('product_name').notNull(),
    unitPricePaise: integer('unit_price_paise').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalPaise: integer('line_total_paise').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.productId] }),
    index('idx_order_items_product').on(t.productId),
    check('order_items_unit_price_non_negative', sql`${t.unitPricePaise} >= 0`),
    check('order_items_quantity_positive', sql`${t.quantity} > 0`),
    check('order_items_line_total_non_negative', sql`${t.lineTotalPaise} >= 0`),
  ],
);

export const coupons = sqliteTable(
  'coupons',
  {
    code: text('code').primaryKey(),
    milestone: integer('milestone').notNull().unique(),
    // Order count that unlocked this coupon (milestone * n at generation time).
    unlockedAtOrder: integer('unlocked_at_order').notNull(),
    discountPercent: integer('discount_percent').notNull(),
    status: text('status', { enum: ['AVAILABLE', 'REDEEMED'] }).notNull(),
    generatedAt: text('generated_at').notNull(),
    redeemedOrderId: text('redeemed_order_id')
      .unique()
      .references(() => orders.id),
    redeemedAt: text('redeemed_at'),
  },
  (t) => [
    check('coupons_milestone_positive', sql`${t.milestone} >= 1`),
    check('coupons_percent_range', sql`${t.discountPercent} BETWEEN 1 AND 100`),
    check('coupons_status_valid', sql`${t.status} IN ('AVAILABLE', 'REDEEMED')`),
    check(
      'coupons_redeemed_has_order',
      sql`(${t.status} = 'REDEEMED') = (${t.redeemedOrderId} IS NOT NULL)`,
    ),
  ],
);

export const idempotencyKeys = sqliteTable('idempotency_keys', {
  key: text('key').primaryKey(),
  cartId: text('cart_id').notNull(),
  requestHash: text('request_hash').notNull(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id),
  createdAt: text('created_at').notNull(),
});

export type Product = typeof products.$inferSelect;
export type Cart = typeof carts.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type Order = typeof orders.$inferSelect;
