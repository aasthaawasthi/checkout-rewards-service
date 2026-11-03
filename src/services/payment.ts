import { randomUUID } from 'node:crypto';

/**
 * Minimal payment abstraction. The assignment needs no real payment provider;
 * the abstraction exists to prove one property: a checkout that fails at the
 * payment step leaves no trace (stock, coupon, cart and order are untouched).
 *
 * It is deliberately synchronous: the fake is called inside the checkout's
 * database transaction, so a decline rolls the whole transaction back.
 * A real provider is a network call and must NOT run inside a DB transaction.
 * DECISIONS.md ("Payment") describes the reserve -> charge -> confirm flow
 * that would replace this in production.
 */
export interface ChargeRequest {
  orderId: string;
  amountPaise: number;
  idempotencyKey: string;
  /** Test/demo hook: force a decline (sent as the X-Simulate-Payment: decline header). */
  simulateDecline?: boolean;
}

export type ChargeResult = { ok: true; reference: string } | { ok: false; reason: string };

export interface PaymentGateway {
  charge(request: ChargeRequest): ChargeResult;
}

/** Approves everything unless told to decline. Zero-amount orders are approved without a charge. */
export class FakePaymentGateway implements PaymentGateway {
  private declineAll = false;
  public readonly charges: ChargeRequest[] = [];

  setDeclineAll(value: boolean): void {
    this.declineAll = value;
  }

  charge(request: ChargeRequest): ChargeResult {
    this.charges.push(request);
    if (this.declineAll || request.simulateDecline) {
      return { ok: false, reason: 'Card declined (simulated)' };
    }
    return { ok: true, reference: request.amountPaise === 0 ? 'no-charge' : `fakepay_${randomUUID()}` };
  }
}
