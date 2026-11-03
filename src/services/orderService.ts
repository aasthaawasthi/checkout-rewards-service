import { asc, eq } from 'drizzle-orm';
import { DB } from '../db/database';
import { orderItems, orders } from '../db/schema';
import { notFound } from '../domain/errors';
import { formatInr } from '../domain/money';

/**
 * Orders are read entirely from their own snapshot tables, never joined to
 * live product data, so they always describe exactly what was purchased and
 * how the total was calculated.
 */
export class OrderService {
  constructor(private readonly db: DB) {}

  get(orderId: string) {
    const order = this.db.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw notFound('ORDER_NOT_FOUND', `Order ${orderId} does not exist`, { orderId });
    const items = this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.productId))
      .all();

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      cartId: order.cartId,
      status: order.status,
      currency: 'INR',
      items: items.map((i) => ({
        productId: i.productId,
        name: i.productName,
        unitPricePaise: i.unitPricePaise,
        quantity: i.quantity,
        lineTotalPaise: i.lineTotalPaise,
      })),
      subtotalPaise: order.subtotalPaise,
      discount: order.couponCode
        ? {
            couponCode: order.couponCode,
            percent: order.discountPercent,
            amountPaise: order.discountPaise,
            rule: 'floor(subtotalPaise * percent / 100)',
          }
        : null,
      discountPaise: order.discountPaise,
      totalPaise: order.totalPaise,
      totalDisplay: formatInr(order.totalPaise),
      payment: { reference: order.paymentReference },
      createdAt: order.createdAt,
    };
  }
}
