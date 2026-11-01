import { DB } from '../db/database';
import { notFound, unprocessable } from '../domain/errors';

export interface ProductRow {
  id: string;
  name: string;
  price_paise: number;
  stock: number;
  updated_at: string;
}

export function toProductDto(p: ProductRow) {
  return {
    id: p.id,
    name: p.name,
    unitPricePaise: p.price_paise,
    availableStock: p.stock,
    updatedAt: p.updated_at,
  };
}

export class ProductService {
  constructor(private readonly db: DB) {}

  list() {
    const rows = this.db.prepare('SELECT * FROM products ORDER BY id').all() as ProductRow[];
    return rows.map(toProductDto);
  }

  get(id: string) {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined;
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
    return this.db
      .transaction(() => {
        const existing = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as
          | ProductRow
          | undefined;
        if (!existing) throw notFound('PRODUCT_NOT_FOUND', `Product ${id} does not exist`, { productId: id });
        this.db
          .prepare(
            `UPDATE products
               SET price_paise = COALESCE(@price, price_paise),
                   stock       = COALESCE(@stock, stock),
                   updated_at  = @now
             WHERE id = @id`,
          )
          .run({
            id,
            price: changes.unitPricePaise ?? null,
            stock: changes.stock ?? null,
            now: new Date().toISOString(),
          });
        return toProductDto(this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow);
      })
      .immediate();
  }
}
