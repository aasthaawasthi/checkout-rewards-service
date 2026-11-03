import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB, Tx } from '../db/database';
import { Cart, Product, cartItems, carts, orders, products } from '../db/schema';
import { conflict, notFound, unprocessable } from '../domain/errors';
import { formatInr, lineTotal, sum } from '../domain/money';

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
    const now = new Date().toISOString();
    const cart = this.db
      .insert(carts)
      .values({ id: randomUUID(), status: 'OPEN', createdAt: now, updatedAt: now })
      .returning()
      .get();
    return this.view(cart.id);
  }

  view(cartId: string) {
    const cart = getCart(this.db, cartId);
    const lines = this.db
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
      .where(eq(cartItems.cartId, cartId))
      .orderBy(asc(cartItems.addedAt), asc(cartItems.productId))
      .all();

    const order = this.db.select({ id: orders.id }).from(orders).where(eq(orders.cartId, cartId)).get();

    const items = lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      // Current catalogue price: this is what checkout would charge.
      unitPricePaise: l.pricePaise,
      // Price the customer was last shown when adding/updating this line.
      priceSeenPaise: l.priceSeenPaise,
      priceChanged: l.pricePaise !== l.priceSeenPaise,
      lineTotalPaise: lineTotal(l.pricePaise, l.quantity),
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
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    };
  }

  /**
   * Adds a product that is not yet in the cart. Adding a product that is already
   * present is rejected (use PATCH to change quantity) so a retried "add"
   * request cannot double the quantity.
   */
  addItem(cartId: string, productId: string, quantity: number) {
    this.db.transaction(
      (tx) => {
        getOpenCart(tx, cartId);
        const product = getProductForCart(tx, productId);
        if (findLine(tx, cartId, productId)) {
          throw conflict(
            'ITEM_ALREADY_IN_CART',
            `Product ${productId} is already in the cart; use PATCH to change its quantity`,
            { productId },
          );
        }
        assertStock(product, quantity);
        const now = new Date().toISOString();
        tx.insert(cartItems)
          .values({ cartId, productId, quantity, priceSeenPaise: product.pricePaise, addedAt: now })
          .run();
        touch(tx, cartId, now);
      },
      { behavior: 'immediate' },
    );
    return this.view(cartId);
  }

  /** Sets an absolute quantity (idempotent: repeating it changes nothing). */
  updateItem(cartId: string, productId: string, quantity: number) {
    this.db.transaction(
      (tx) => {
        getOpenCart(tx, cartId);
        const product = getProductForCart(tx, productId);
        assertInCart(tx, cartId, productId);
        assertStock(product, quantity);
        const now = new Date().toISOString();
        // Changing the quantity is an explicit customer action on this line, so
        // the price they are now looking at becomes the accepted price.
        tx.update(cartItems)
          .set({ quantity, priceSeenPaise: product.pricePaise })
          .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
          .run();
        touch(tx, cartId, now);
      },
      { behavior: 'immediate' },
    );
    return this.view(cartId);
  }

  /**
   * The customer explicitly accepts the current catalogue prices for every line
   * (after checkout answered PRICE_CHANGED). Kept as a separate, deliberate
   * step so a blind checkout retry can never charge a price the customer has
   * not seen.
   */
  acceptCurrentPrices(cartId: string) {
    this.db.transaction(
      (tx) => {
        getOpenCart(tx, cartId);
        const lines = tx
          .select({ productId: cartItems.productId, pricePaise: products.pricePaise })
          .from(cartItems)
          .innerJoin(products, eq(products.id, cartItems.productId))
          .where(eq(cartItems.cartId, cartId))
          .all();
        for (const line of lines) {
          tx.update(cartItems)
            .set({ priceSeenPaise: line.pricePaise })
            .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, line.productId)))
            .run();
        }
        touch(tx, cartId, new Date().toISOString());
      },
      { behavior: 'immediate' },
    );
    return this.view(cartId);
  }

  removeItem(cartId: string, productId: string) {
    this.db.transaction(
      (tx) => {
        getOpenCart(tx, cartId);
        assertInCart(tx, cartId, productId);
        tx.delete(cartItems)
          .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
          .run();
        touch(tx, cartId, new Date().toISOString());
      },
      { behavior: 'immediate' },
    );
    return this.view(cartId);
  }
}

// ---- helpers (work with the db handle or a transaction) ---------------------

type Conn = DB | Tx;

function getCart(conn: Conn, cartId: string): Cart {
  const cart = conn.select().from(carts).where(eq(carts.id, cartId)).get();
  if (!cart) throw notFound('CART_NOT_FOUND', `Cart ${cartId} does not exist`, { cartId });
  return cart;
}

function getOpenCart(conn: Conn, cartId: string): Cart {
  const cart = getCart(conn, cartId);
  if (cart.status !== 'OPEN') {
    throw conflict('CART_NOT_OPEN', 'Cart has already been checked out and can no longer be changed', {
      cartId,
      status: cart.status,
    });
  }
  return cart;
}

function getProductForCart(conn: Conn, productId: string): Product {
  const product = conn.select().from(products).where(eq(products.id, productId)).get();
  // 422 rather than 404: the URL (the cart) exists; the body references something invalid.
  if (!product) throw unprocessable('PRODUCT_NOT_FOUND', `Product ${productId} does not exist`, { productId });
  return product;
}

function findLine(conn: Conn, cartId: string, productId: string) {
  return conn
    .select({ quantity: cartItems.quantity })
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)))
    .get();
}

function assertInCart(conn: Conn, cartId: string, productId: string): void {
  if (!findLine(conn, cartId, productId)) {
    throw notFound('ITEM_NOT_IN_CART', `Product ${productId} is not in the cart`, { productId });
  }
}

function assertStock(product: Product, quantity: number): void {
  if (product.stock < quantity) {
    throw conflict('INSUFFICIENT_STOCK', `Only ${product.stock} of ${product.name} available`, {
      items: [{ productId: product.id, requested: quantity, available: product.stock }],
    });
  }
}

function touch(conn: Conn, cartId: string, now: string): void {
  conn.update(carts).set({ updatedAt: now }).where(eq(carts.id, cartId)).run();
}
