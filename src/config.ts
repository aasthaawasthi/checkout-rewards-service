/**
 * Runtime configuration, read once from environment variables.
 *
 * n (ORDER_MILESTONE_N): every n-th successfully placed order unlocks one coupon.
 * x (DISCOUNT_PERCENT_X): percentage discount of coupons generated from now on.
 *
 * Both are validated at startup so the service never runs with a config that
 * would produce nonsensical coupons (n = 0, x = 150 %, fractional percents...).
 */
export interface AppConfig {
  port: number;
  dbPath: string;
  milestoneN: number;
  discountPercentX: number;
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: intFromEnv('PORT', 3000, 1, 65535),
    dbPath: process.env.DB_PATH || 'data/store.db',
    milestoneN: intFromEnv('ORDER_MILESTONE_N', 5, 1, 1_000_000),
    discountPercentX: intFromEnv('DISCOUNT_PERCENT_X', 10, 1, 100),
  };
}
