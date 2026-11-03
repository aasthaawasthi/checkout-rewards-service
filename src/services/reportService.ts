import { asc, count, eq, max, sum } from 'drizzle-orm';
import { DB } from '../db/database';
import { coupons, orderItems, orders, products } from '../db/schema';
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
    return this.db.transaction(
      (tx) => {
        // Drizzle returns SUM() as a string (it could exceed JS number range);
        // our bounds keep it safe, so map it back to a number.
        const totals = tx
          .select({
            orders: count(),
            gross: sum(orders.subtotalPaise).mapWith(Number),
            discount: sum(orders.discountPaise).mapWith(Number),
            net: sum(orders.totalPaise).mapWith(Number),
            ordersWithCoupon: count(orders.couponCode), // COUNT(col) skips NULLs
          })
          .from(orders)
          .get()!;

        const byProduct = tx
          .select({
            productId: orderItems.productId,
            currentName: max(products.name),
            snapshotName: max(orderItems.productName),
            quantity: sum(orderItems.quantity).mapWith(Number),
            grossRevenuePaise: sum(orderItems.lineTotalPaise).mapWith(Number),
          })
          .from(orderItems)
          .leftJoin(products, eq(products.id, orderItems.productId))
          .groupBy(orderItems.productId)
          .orderBy(asc(orderItems.productId))
          .all()
          .map(({ currentName, snapshotName, ...rest }) => ({
            productId: rest.productId,
            name: currentName ?? snapshotName,
            quantity: rest.quantity,
            grossRevenuePaise: rest.grossRevenuePaise,
          }));

        const couponRows = tx
          .select({ status: coupons.status, n: count() })
          .from(coupons)
          .groupBy(coupons.status)
          .all();
        const available = couponRows.find((r) => r.status === 'AVAILABLE')?.n ?? 0;
        const redeemed = couponRows.find((r) => r.status === 'REDEEMED')?.n ?? 0;
        const couponCounts = { generated: available + redeemed, available, redeemed };

        const gross = totals.gross ?? 0;
        const discount = totals.discount ?? 0;
        const net = totals.net ?? 0;
        const reached = Math.floor(totals.orders / this.milestoneN);

        return {
          currency: 'INR',
          totalOrders: totals.orders,
          purchasedByProduct: byProduct,
          totalItemsPurchased: byProduct.reduce((acc, p) => acc + p.quantity, 0),
          grossRevenuePaise: gross,
          totalDiscountPaise: discount,
          netRevenuePaise: net,
          display: {
            grossRevenue: formatInr(gross),
            totalDiscount: formatInr(discount),
            netRevenue: formatInr(net),
          },
          ordersWithCoupon: totals.ordersWithCoupon,
          coupons: couponCounts,
          milestones: {
            n: this.milestoneN,
            discountPercentForNewCoupons: this.discountPercentX,
            reached,
            rewarded: couponCounts.generated,
            awaitingGeneration: reached - couponCounts.generated,
            nextMilestoneAtOrder: (reached + 1) * this.milestoneN,
          },
        };
      },
      { behavior: 'deferred' },
    );
  }
}
