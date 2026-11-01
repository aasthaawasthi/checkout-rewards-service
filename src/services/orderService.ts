import { DB } from '../db/database';
import { notFound } from '../domain/errors';
import { formatInr } from '../domain/money';

interface OrderRow {
  id: string;
  order_number: number;
  cart_id: string;
  status: string;
  subtotal_paise: number;
  discount_paise: number;
  total_paise: number;
  coupon_code: string | null;
  discount_percent: number | null;
  payment_reference: string;
  created_at: string;
}

interface OrderItemRow {
  product_id: string;
  product_name: string;
  unit_price_paise: number;
  quantity: number;
  line_total_paise: number;
}

/**
 * Orders are read entirely from their own snapshot tables, never joined to
 * live product data, so they always describe exactly what was purchased and
 * how the total was calculated.
 */
export class OrderService {
  constructor(private readonly db: DB) {}

  get(orderId: string) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined;
    if (!order) throw notFound('ORDER_NOT_FOUND', `Order ${orderId} does not exist`, { orderId });
    const items = this.db
      .prepare(
        `SELECT product_id, product_name, unit_price_paise, quantity, line_total_paise
           FROM order_items WHERE order_id = ? ORDER BY product_id`,
      )
      .all(orderId) as OrderItemRow[];

    return {
      id: order.id,
      orderNumber: order.order_number,
      cartId: order.cart_id,
      status: order.status,
      currency: 'INR',
      items: items.map((i) => ({
        productId: i.product_id,
        name: i.product_name,
        unitPricePaise: i.unit_price_paise,
        quantity: i.quantity,
        lineTotalPaise: i.line_total_paise,
      })),
      subtotalPaise: order.subtotal_paise,
      discount: order.coupon_code
        ? {
            couponCode: order.coupon_code,
            percent: order.discount_percent,
            amountPaise: order.discount_paise,
            rule: 'floor(subtotalPaise * percent / 100)',
          }
        : null,
      discountPaise: order.discount_paise,
      totalPaise: order.total_paise,
      totalDisplay: formatInr(order.total_paise),
      payment: { reference: order.payment_reference },
      createdAt: order.created_at,
    };
  }
}
