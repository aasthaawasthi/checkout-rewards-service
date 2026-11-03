import { asc, count } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { DB } from '../db/database';
import { Coupon, coupons, orders } from '../db/schema';
import { conflict } from '../domain/errors';

// No 0/O/1/I to avoid codes that are hard to read aloud or type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSuffix(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function toCouponDto(c: Coupon) {
  return {
    code: c.code,
    milestone: c.milestone,
    unlockedAtOrder: c.unlockedAtOrder,
    discountPercent: c.discountPercent,
    status: c.status,
    generatedAt: c.generatedAt,
    redeemedOrderId: c.redeemedOrderId,
    redeemedAt: c.redeemedAt,
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
    return this.db.transaction(
      (tx) => {
        const { placed } = tx.select({ placed: count() }).from(orders).get()!;
        const reached = Math.floor(placed / this.milestoneN);
        const rewarded = new Set(
          tx
            .select({ milestone: coupons.milestone })
            .from(coupons)
            .all()
            .map((r) => r.milestone),
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

        const coupon = tx
          .insert(coupons)
          .values({
            code: `REWARD-M${milestone}-${randomSuffix()}`,
            milestone,
            unlockedAtOrder: milestone * this.milestoneN,
            discountPercent: this.discountPercentX,
            status: 'AVAILABLE',
            generatedAt: new Date().toISOString(),
          })
          .returning()
          .get();

        return { coupon: toCouponDto(coupon), remainingEligibleMilestones: reached - rewarded.size - 1 };
      },
      { behavior: 'immediate' },
    );
  }

  list() {
    return this.db.select().from(coupons).orderBy(asc(coupons.milestone)).all().map(toCouponDto);
  }
}
