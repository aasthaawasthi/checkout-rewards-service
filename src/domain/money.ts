/**
 * Money rules (see DECISIONS.md "Money and rounding"):
 *  - All amounts are integers in paise (minor units). No floats are stored or summed.
 *  - Line total = unit price * quantity (exact integer).
 *  - Discount = floor(subtotal * percent / 100): computed once on the order
 *    subtotal, rounded down in paise. Rounding down means the customer never
 *    receives more than the advertised percentage and the result is identical
 *    on every run.
 *  - Total = subtotal - discount, and since percent <= 100 the total is never negative.
 *
 * Bounds: prices are capped at 10^9 paise and quantities at 1000 per line, so
 * every intermediate value stays far below Number.MAX_SAFE_INTEGER (~9 * 10^15).
 */

export const MAX_UNIT_PRICE_PAISE = 1_000_000_000;
export const MAX_LINE_QUANTITY = 1000;

function assertSafeNonNegativeInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

export function lineTotal(unitPricePaise: number, quantity: number): number {
  assertSafeNonNegativeInt(unitPricePaise, 'unitPricePaise');
  assertSafeNonNegativeInt(quantity, 'quantity');
  const total = unitPricePaise * quantity;
  assertSafeNonNegativeInt(total, 'lineTotal');
  return total;
}

export function sum(values: number[]): number {
  const total = values.reduce((acc, v) => acc + v, 0);
  assertSafeNonNegativeInt(total, 'sum');
  return total;
}

export function percentDiscount(subtotalPaise: number, percent: number): number {
  assertSafeNonNegativeInt(subtotalPaise, 'subtotalPaise');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(`percent must be an integer between 0 and 100, got ${percent}`);
  }
  // Integer multiply first, then integer divide: exact, no fractional paise.
  const discount = Math.floor((subtotalPaise * percent) / 100);
  return Math.min(discount, subtotalPaise);
}

/** Display helper only. Never used for arithmetic. */
export function formatInr(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = String(paise % 100).padStart(2, '0');
  return `₹${rupees.toLocaleString('en-IN')}.${rest}`;
}
