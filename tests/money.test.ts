import { formatInr, lineTotal, percentDiscount, sum } from '../src/domain/money';

describe('money rules (integer paise)', () => {
  it('rounds the discount down to whole paise, deterministically', () => {
    // 1299.99 * 15% = 194.9985 -> 194.99 (rounded down, never up)
    expect(percentDiscount(129_999, 15)).toBe(19_499);
    // 0.01 * 10% = 0.001 -> 0 paise
    expect(percentDiscount(1, 10)).toBe(0);
    // exact case stays exact
    expect(percentDiscount(10_000, 10)).toBe(1_000);
  });

  it('never makes a total negative, even at 100%', () => {
    for (const subtotal of [0, 1, 99, 129_999, 999_999_999]) {
      const discount = percentDiscount(subtotal, 100);
      expect(discount).toBe(subtotal);
      expect(subtotal - discount).toBe(0);
    }
  });

  it('avoids the classic float error: 0.1 + 0.2', () => {
    // In rupees as floats this would be 0.30000000000000004.
    expect(sum([10, 20])).toBe(30);
    expect(lineTotal(29_950, 3)).toBe(89_850);
  });

  it('rejects invalid inputs instead of producing fractional money', () => {
    expect(() => lineTotal(10.5, 2)).toThrow();
    expect(() => percentDiscount(100, 12.5)).toThrow();
    expect(() => percentDiscount(100, 101)).toThrow();
    expect(() => percentDiscount(-1, 10)).toThrow();
  });

  it('formats paise for display only', () => {
    expect(formatInr(129_999)).toBe('₹1,299.99');
    expect(formatInr(5)).toBe('₹0.05');
  });
});
