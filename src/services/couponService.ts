import { randomInt } from 'crypto';
import { DB } from '../db/database';
import { conflict } from '../domain/errors';

interface CouponRow {
  code: string;
  milestone: number;
  unlocked_at_order: number;
  discount_percent: number;
  status: 'AVAILABLE' | 'REDEEMED';
  generated_at: string;
  redeemed_order_id: string | null;
  redeemed_at: string | null;
}

// No 0/O/1/I to avoid codes that are hard to read aloud or type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSuffix(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function toCouponDto(c: CouponRow) {
  return {
    code: c.code,
    milestone: c.milestone,
    unlockedAtOrder: c.unlocked_at_order,
    discountPercent: c.discount_percent,
    status: c.status,
    generatedAt: c.generated_at,
    redeemedOrderId: c.redeemed_order_id,
    redeemedAt: c.redeemed_at,
  };
}

/**
 * Milestone coupons.
 *
 * Milestone k is reached when the store has placed k * n orders (k >= 1).
 * An admin call generates the coupon for the EARLIEST reached milestone that
 * has no coupon yet; one call -> at most one coupon. If several milestones are
 * pending (admin was slow), repeated calls catch up one by one, and the
 * response says how many remain.
 *
 * "At most one coupon per milestone" is enforced twice: the transaction holds
 * the write lock while it decides, and coupons.milestone is UNIQUE, so even a
 * buggy concurrent path could not insert a duplicate.
 *
 * The coupon stores its own discount percent (x at generation time), so
 * changing x later never changes the value of coupons already issued.
 */
export class CouponService {
  constructor(
    private readonly db: DB,
    private readonly milestoneN: number,
    private readonly discountPercentX: number,
  ) {}

  generate() {
    return this.db
      .transaction(() => {
        const { placed } = this.db.prepare('SELECT COUNT(*) AS placed FROM orders').get() as { placed: number };
        const reached = Math.floor(placed / this.milestoneN);
        const rewarded = new Set(
          (this.db.prepare('SELECT milestone FROM coupons').all() as { milestone: number }[]).map((r) => r.milestone),
        );

        let milestone: number | undefined;
        for (let k = 1; k <= reached; k++) {
          if (!rewarded.has(k)) {
            milestone = k;
            break;
          }
        }

        if (milestone === undefined) {
          throw conflict('NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone has been reached yet', {
            placedOrders: placed,
            milestoneN: this.milestoneN,
            milestonesReached: reached,
            nextMilestoneAtOrder: (reached + 1) * this.milestoneN,
          });
        }

        const now = new Date().toISOString();
        const code = `REWARD-M${milestone}-${randomSuffix()}`;
        this.db
          .prepare(
            `INSERT INTO coupons (code, milestone, unlocked_at_order, discount_percent, status, generated_at)
             VALUES (?, ?, ?, ?, 'AVAILABLE', ?)`,
          )
          .run(code, milestone, milestone * this.milestoneN, this.discountPercentX, now);

        const pending = reached - rewarded.size - 1;
        const coupon = this.db.prepare('SELECT * FROM coupons WHERE code = ?').get(code) as CouponRow;
        return { coupon: toCouponDto(coupon), remainingEligibleMilestones: pending };
      })
      .immediate();
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM coupons ORDER BY milestone').all() as CouponRow[];
    return rows.map(toCouponDto);
  }
}
