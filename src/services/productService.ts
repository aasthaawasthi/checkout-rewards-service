import { asc, eq } from 'drizzle-orm';
import { DB } from '../db/database';
import { Product, products } from '../db/schema';
import { notFound, unprocessable } from '../domain/errors';

export function toProductDto(p: Product) {
  return {
    id: p.id,
    name: p.name,
    unitPricePaise: p.pricePaise,
    availableStock: p.stock,
    updatedAt: p.updatedAt,
  };
}

export class ProductService {
  constructor(private readonly db: DB) {}

  list() {
    return this.db.select().from(products).orderBy(asc(products.id)).all().map(toProductDto);
  }

  get(id: string) {
    const row = this.db.select().from(products).where(eq(products.id, id)).get();
    if (!row) throw notFound('PRODUCT_NOT_FOUND', `Product ${id} does not exist`, { productId: id });
    return toProductDto(row);
  }

  /**
   * Admin operation to change a product's price and/or stock. It exists so the
   * "price or availability changed after the item was added" behaviour can be
   * exercised end to end. Stock is set to an absolute value.
   */
  adminUpdate(id: string, changes: { unitPricePaise?: number; stock?: number }) {
    if (changes.unitPricePaise === undefined && changes.stock === undefined) {
      throw unprocessable('VALIDATION_ERROR', 'Provide unitPricePaise and/or stock');
    }
    return this.db.transaction(
      (tx) => {
        const updated = tx
          .update(products)
          .set({
            ...(changes.unitPricePaise !== undefined && { pricePaise: changes.unitPricePaise }),
            ...(changes.stock !== undefined && { stock: changes.stock }),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(products.id, id))
          .returning()
          .get();
        if (!updated) throw notFound('PRODUCT_NOT_FOUND', `Product ${id} does not exist`, { productId: id });
        return toProductDto(updated);
      },
      { behavior: 'immediate' },
    );
  }
}
