import { z } from 'zod';
import { MAX_LINE_QUANTITY, MAX_UNIT_PRICE_PAISE } from '../domain/money';

// Quantities must be JSON integers; "2" (a string) or 2.5 are rejected rather
// than coerced, so invalid input never silently enters a cart.
const quantity = z.number().int().min(1).max(MAX_LINE_QUANTITY);

export const addItemBody = z.strictObject({
  productId: z.string().trim().min(1).max(100),
  quantity,
});

export const updateItemBody = z.strictObject({ quantity });

export const checkoutBody = z.strictObject({
  couponCode: z.string().trim().min(1).max(64).optional(),
});

export const adminUpdateProductBody = z.strictObject({
  unitPricePaise: z.number().int().min(0).max(MAX_UNIT_PRICE_PAISE).optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(),
});

/** Idempotency keys: opaque client-chosen strings, typically UUIDs. */
export const idempotencyKey = z
  .string()
  .trim()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key may only contain letters, digits and . _ : -');
