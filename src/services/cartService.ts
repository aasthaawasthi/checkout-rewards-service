import { randomUUID } from 'crypto';
import { DB } from '../db/database';
import { conflict, notFound, unprocessable } from '../domain/errors';
import { formatInr, lineTotal, sum } from '../domain/money';
import { ProductRow } from './productService';

export interface CartRow {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  created_at: string;
  updated_at: string;
}

interface CartLineRow {
  product_id: string;
  quantity: number;
  price_seen_paise: number;
  name: string;
  price_paise: number;
  stock: number;
}

/**
 * Cart operations.
 *
 * Every write runs in an IMMEDIATE transaction and re-checks that the cart is
 * still OPEN inside that transaction. Checkout also takes the write lock, so an
 * "add item" racing a checkout either lands before the checkout (and is bought)
 * or after it (and is rejected with CART_NOT_OPEN). It can never be silently
 * dropped or added to an already-placed order.
 *
 * Stock is checked when an item is added or changed, as early feedback only.
 * It is NOT reserved: the authoritative check happens atomically at checkout.
 */
export class CartService {
  constructor(private readonly db: DB) {}

  create() {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO carts (id, status, created_at, updated_at) VALUES (?, 'OPEN', ?, ?)`)
      .run(id, now, now);
    return this.view(id);
  }

  view(cartId: string) {
    const cart = this.getCart(cartId);
    const lines = this.db
      .prepare(
        `SELECT ci.product_id, ci.quantity, ci.price_seen_paise, p.name, p.price_paise, p.stock
           FROM cart_items ci JOIN products p ON p.id = ci.product_id
          WHERE ci.cart_id = ?
          ORDER BY ci.added_at, ci.product_id`,
      )
      .all(cartId) as CartLineRow[];

    const order = this.db.prepare('SELECT id FROM orders WHERE cart_id = ?').get(cartId) as
      | { id: string }
      | undefined;

    const items = lines.map((l) => ({
      productId: l.product_id,
      name: l.name,
      quantity: l.quantity,
      // Current catalogue price: this is what checkout would charge.
      unitPricePaise: l.price_paise,
      // Price the customer was last shown when adding/updating this line.
      priceSeenPaise: l.price_seen_paise,
      priceChanged: l.price_paise !== l.price_seen_paise,
      lineTotalPaise: lineTotal(l.price_paise, l.quantity),
      availableStock: l.stock,
      sufficientStock: l.stock >= l.quantity,
    }));

    const subtotalPaise = sum(items.map((i) => i.lineTotalPaise));
    const warnings = [
      ...items
        .filter((i) => i.priceChanged)
        .map((i) => ({
          code: 'PRICE_CHANGED',
          productId: i.productId,
          priceSeenPaise: i.priceSeenPaise,
          currentPricePaise: i.unitPricePaise,
        })),
      ...items
        .filter((i) => !i.sufficientStock)
        .map((i) => ({
          code: 'INSUFFICIENT_STOCK',
          productId: i.productId,
          requested: i.quantity,
          available: i.availableStock,
        })),
    ];

    return {
      id: cart.id,
      status: cart.status,
      orderId: order?.id ?? null,
      currency: 'INR',
      items,
      itemCount: sum(items.map((i) => i.quantity)),
      subtotalPaise,
      subtotalDisplay: formatInr(subtotalPaise),
      // Only relevant while the cart is still open.
      warnings: cart.status === 'OPEN' ? warnings : [],
      createdAt: cart.created_at,
      updatedAt: cart.updated_at,
    };
  }

  /**
   * Adds a product that is not yet in the cart. Adding a product that is already
   * present is rejected (use PATCH to change quantity) so a retried "add"
   * request cannot double the quantity.
   */
  addItem(cartId: string, productId: string, quantity: number) {
    this.db
      .transaction(() => {
        this.getOpenCart(cartId);
        const product = this.getProduct(productId);
        const existing = this.db
          .prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?')
          .get(cartId, productId);
        if (existing) {
          throw conflict('ITEM_ALREADY_IN_CART', `Product ${productId} is already in the cart; use PATCH to change its quantity`, {
            productId,
          });
        }
        this.assertStock(product, quantity);
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO cart_items (cart_id, product_id, quantity, price_seen_paise, added_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(cartId, productId, quantity, product.price_paise, now);
        this.touch(cartId, now);
      })
      .immediate();
    return this.view(cartId);
  }

  /** Sets an absolute quantity (idempotent: repeating it changes nothing). */
  updateItem(cartId: string, productId: string, quantity: number) {
    this.db
      .transaction(() => {
        this.getOpenCart(cartId);
        const product = this.getProduct(productId);
        this.assertInCart(cartId, productId);
        this.assertStock(product, quantity);
        const now = new Date().toISOString();
        // Changing the quantity is an explicit customer action on this line, so
        // the price they are now looking at becomes the accepted price.
        this.db
          .prepare(
            `UPDATE cart_items SET quantity = ?, price_seen_paise = ?
              WHERE cart_id = ? AND product_id = ?`,
          )
          .run(quantity, product.price_paise, cartId, productId);
        this.touch(cartId, now);
      })
      .immediate();
    return this.view(cartId);
  }

  /**
   * The customer explicitly accepts the current catalogue prices for every line
   * (after checkout answered PRICE_CHANGED). Kept as a separate, deliberate
   * step so a blind checkout retry can never charge a price the customer has
   * not seen.
   */
  acceptCurrentPrices(cartId: string) {
    this.db
      .transaction(() => {
        this.getOpenCart(cartId);
        this.db
          .prepare(
            `UPDATE cart_items
                SET price_seen_paise = (SELECT price_paise FROM products p WHERE p.id = cart_items.product_id)
              WHERE cart_id = ?`,
          )
          .run(cartId);
        this.touch(cartId, new Date().toISOString());
      })
      .immediate();
    return this.view(cartId);
  }

  removeItem(cartId: string, productId: string) {
    this.db
      .transaction(() => {
        this.getOpenCart(cartId);
        this.assertInCart(cartId, productId);
        this.db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?').run(cartId, productId);
        this.touch(cartId, new Date().toISOString());
      })
      .immediate();
    return this.view(cartId);
  }

  // ---- helpers -------------------------------------------------------------

  private getCart(cartId: string): CartRow {
    const cart = this.db.prepare('SELECT * FROM carts WHERE id = ?').get(cartId) as CartRow | undefined;
    if (!cart) throw notFound('CART_NOT_FOUND', `Cart ${cartId} does not exist`, { cartId });
    return cart;
  }

  private getOpenCart(cartId: string): CartRow {
    const cart = this.getCart(cartId);
    if (cart.status !== 'OPEN') {
      throw conflict('CART_NOT_OPEN', 'Cart has already been checked out and can no longer be changed', {
        cartId,
        status: cart.status,
      });
    }
    return cart;
  }

  private getProduct(productId: string): ProductRow {
    const product = this.db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
      | ProductRow
      | undefined;
    // 422 rather than 404: the URL (the cart) exists; the body references something invalid.
    if (!product) throw unprocessable('PRODUCT_NOT_FOUND', `Product ${productId} does not exist`, { productId });
    return product;
  }

  private assertInCart(cartId: string, productId: string): void {
    const row = this.db
      .prepare('SELECT 1 FROM cart_items WHERE cart_id = ? AND product_id = ?')
      .get(cartId, productId);
    if (!row) throw notFound('ITEM_NOT_IN_CART', `Product ${productId} is not in the cart`, { productId });
  }

  private assertStock(product: ProductRow, quantity: number): void {
    if (product.stock < quantity) {
      throw conflict('INSUFFICIENT_STOCK', `Only ${product.stock} of ${product.name} available`, {
        items: [{ productId: product.id, requested: quantity, available: product.stock }],
      });
    }
  }

  private touch(cartId: string, now: string): void {
    this.db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(now, cartId);
  }
}
