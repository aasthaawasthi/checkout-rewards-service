import { DB } from '../db/database';
import { formatInr } from '../domain/money';

/**
 * Admin summary. Read-only: it runs in one (deferred) read transaction, which
 * in WAL mode sees a single consistent snapshot, so the numbers always
 * reconcile with each other even while checkouts are committing.
 *
 * Everything is derived from orders, order_items and coupons, the same rows
 * GET /orders/:id and GET /admin/coupons return, so the report can be
 * reconciled against them:
 *   grossRevenue  = SUM(orders.subtotal)  = SUM(order_items.line_total)
 *   totalDiscount = SUM(orders.discount)
 *   netRevenue    = SUM(orders.total)     = gross - discount
 */
export class ReportService {
  constructor(
    private readonly db: DB,
    private readonly milestoneN: number,
    private readonly discountPercentX: number,
  ) {}

  summary() {
    return this.db.transaction(() => {
      const totals = this.db
        .prepare(
          `SELECT COUNT(*) AS orders,
                  COALESCE(SUM(subtotal_paise), 0) AS gross,
                  COALESCE(SUM(discount_paise), 0) AS discount,
                  COALESCE(SUM(total_paise), 0)    AS net,
                  COALESCE(SUM(CASE WHEN coupon_code IS NOT NULL THEN 1 ELSE 0 END), 0) AS discounted_orders
             FROM orders`,
        )
        .get() as { orders: number; gross: number; discount: number; net: number; discounted_orders: number };

      const byProduct = this.db
        .prepare(
          `SELECT oi.product_id AS productId,
                  COALESCE(p.name, MAX(oi.product_name)) AS name,
                  SUM(oi.quantity) AS quantity,
                  SUM(oi.line_total_paise) AS grossRevenuePaise
             FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
            GROUP BY oi.product_id
            ORDER BY oi.product_id`,
        )
        .all() as { productId: string; name: string; quantity: number; grossRevenuePaise: number }[];

      const coupons = this.db
        .prepare(
          `SELECT COUNT(*) AS generated,
                  COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END), 0) AS available,
                  COALESCE(SUM(CASE WHEN status = 'REDEEMED'  THEN 1 ELSE 0 END), 0) AS redeemed
             FROM coupons`,
        )
        .get() as { generated: number; available: number; redeemed: number };

      const reached = Math.floor(totals.orders / this.milestoneN);

      return {
        currency: 'INR',
        totalOrders: totals.orders,
        purchasedByProduct: byProduct,
        totalItemsPurchased: byProduct.reduce((acc, p) => acc + p.quantity, 0),
        grossRevenuePaise: totals.gross,
        totalDiscountPaise: totals.discount,
        netRevenuePaise: totals.net,
        display: {
          grossRevenue: formatInr(totals.gross),
          totalDiscount: formatInr(totals.discount),
          netRevenue: formatInr(totals.net),
        },
        ordersWithCoupon: totals.discounted_orders,
        coupons,
        milestones: {
          n: this.milestoneN,
          discountPercentForNewCoupons: this.discountPercentX,
          reached,
          rewarded: coupons.generated,
          awaitingGeneration: reached - coupons.generated,
          nextMilestoneAtOrder: (reached + 1) * this.milestoneN,
        },
      };
    })();
  }
}
