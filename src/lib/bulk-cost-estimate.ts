import { GRADETHREAD_TIERS, type GradeTierKey } from "@/lib/constants";

// US-2516. A bulk batch used to POST every row straight at /api/grade/submit
// with no idea what it would cost. The per-submission flow has shown a payment
// estimate since US-207 (new-submission.tsx); this is the same arithmetic run
// over a list of rows instead of one.
//
// Mirrors the server precedence in services/edge-functions/src/lib/
// grade-billing.ts runPaymentPrecedence():
//   1. an included monthly grade — Standard tier only
//   2. the credit balance, at the tier's credit cost
//   3. checkout — the row is still created, but unpaid
//
// Row order matters: the batch submits in CSV order, and the included bundle
// and the credit balance drain as it goes. So the estimate walks the same
// order rather than counting by tier.

export interface BulkCostContext {
  /** Included Standard grades left this period (limit - used, floored at 0). */
  includedRemaining: number;
  /** Grade credits on hand. */
  creditBalance: number;
}

export interface BulkCostEstimate {
  rows: number;
  /** Rows covered by the monthly included bundle. */
  includedRows: number;
  /** Rows paid with credits. */
  creditRows: number;
  /** Credits those rows will spend. */
  creditsSpent: number;
  /** Rows that will be created UNPAID and need checkout afterwards. */
  checkoutRows: number;
  /** What those unpaid rows will cost, in cents, before any reward discount. */
  checkoutCents: number;
  /** Credits still on hand once the batch finishes. */
  creditBalanceAfter: number;
}

const EMPTY: BulkCostEstimate = {
  rows: 0,
  includedRows: 0,
  creditRows: 0,
  creditsSpent: 0,
  checkoutRows: 0,
  checkoutCents: 0,
  creditBalanceAfter: 0,
};

export function estimateBulkCost(
  tiers: readonly GradeTierKey[],
  ctx: BulkCostContext,
): BulkCostEstimate {
  let included = Math.max(0, Math.floor(ctx.includedRemaining));
  let credits = Math.max(0, Math.floor(ctx.creditBalance));
  if (tiers.length === 0) return { ...EMPTY, creditBalanceAfter: credits };

  const out: BulkCostEstimate = { ...EMPTY, rows: tiers.length };

  for (const tier of tiers) {
    const cfg = GRADETHREAD_TIERS[tier];
    if (tier === "standard" && included > 0) {
      included--;
      out.includedRows++;
      continue;
    }
    if (credits >= cfg.creditCost) {
      credits -= cfg.creditCost;
      out.creditsSpent += cfg.creditCost;
      out.creditRows++;
      continue;
    }
    out.checkoutRows++;
    out.checkoutCents += cfg.priceCents;
  }

  out.creditBalanceAfter = credits;
  return out;
}

export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
