// US-399: proration math for an immediate admin paid→free cancel.
//
// The unused-time credit is computed from the REAL amount paid on the latest
// invoice (cents), so coupons and grandfathered prices are honored rather than
// the list price. Pure + dependency-free so the math is unit-testable.

export interface ProrationInput {
  /** Cents actually paid for the current period (invoice.amount_paid). */
  basePaidCents: number;
  /** Unix seconds — current_period_start. */
  periodStartSec: number;
  /** Unix seconds — current_period_end. */
  periodEndSec: number;
  /** Unix seconds — now. */
  nowSec: number;
}

/** Fraction of the period still unused (0..1). */
export function remainingFraction(
  periodStartSec: number,
  periodEndSec: number,
  nowSec: number,
): number {
  if (periodEndSec <= periodStartSec) return 0;
  return Math.max(0, Math.min(1, (periodEndSec - nowSec) / (periodEndSec - periodStartSec)));
}

/** Unused-time proration credit in cents (never negative). */
export function unusedProrationCents(input: ProrationInput): number {
  const frac = remainingFraction(input.periodStartSec, input.periodEndSec, input.nowSec);
  return Math.round(Math.max(0, input.basePaidCents) * frac);
}
