// Pure grade-pricing math — NO supabase / Deno.env dependency, so it's safe to
// unit-test in isolation (see grade-pricing_test.ts). The DB-coupled charging
// logic (runPaymentPrecedence, refunds) lives in grade-billing.ts, which
// re-exports everything here so existing importers are unaffected.

export const GRADE_TIERS = ["standard", "premium", "express"] as const;
export type GradeTier = (typeof GRADE_TIERS)[number];

export function isGradeTier(value: unknown): value is GradeTier {
  return (
    typeof value === "string" &&
    (GRADE_TIERS as readonly string[]).includes(value)
  );
}

// Mirrors src/lib/constants.ts FLIPDESK_PLANS.includedStandardGradesPerMonth.
// Keyed on the current flipdesk_plan column (NOT the legacy `plan` column).
export const INCLUDED_STANDARD_PER_MONTH: Record<string, number> = {
  free: 3,
  starter: 10,
  pro: 30,
  business: 75,
};

// Mirrors GRADETHREAD_TIERS.creditCost.
export const TIER_CREDIT_COST: Record<GradeTier, number> = {
  standard: 1,
  premium: 3,
  express: 5,
};

// Per-grade Stripe price (cents). Mirrors GRADETHREAD_TIERS price.
export const TIER_PRICE_CENTS: Record<GradeTier, number> = {
  standard: 299,
  premium: 799,
  express: 1299,
};

// Dollar value of a tier — used for the historical
// `flipdesk_grading_submissions.cost` record and the UI price hint.
export function tierPriceDollars(tier: GradeTier): number {
  return TIER_PRICE_CENTS[tier] / 100;
}

// Smallest credit pack that satisfies the needed credit cost (upsell hint).
export function suggestPack(creditCost: number) {
  if (creditCost <= 10) return { credits: 10, priceCents: 2499 };
  if (creditCost <= 25) return { credits: 25, priceCents: 5999 };
  if (creditCost <= 50) return { credits: 50, priceCents: 10999 };
  return { credits: 100, priceCents: 19999 };
}

// Resolve the plan that governs included grades, accounting for a paused
// subscription falling back to Free caps.
export function effectivePlanFor(
  plan: string,
  subscriptionStatus: string | null,
): string {
  return subscriptionStatus === "paused" ? "free" : plan;
}

// Credits a batch of ready grades needs after included-standard coverage.
// Included grades apply to Standard only and are spent cheapest-first, matching
// runPaymentPrecedence run per item. `includedRemaining` is the standard grades
// still free this month.
export function computeBatchCredits(
  includedRemaining: number,
  tiers: readonly GradeTier[],
): number {
  let includedLeft = Math.max(0, includedRemaining);
  let credits = 0;
  for (const tier of tiers) {
    if (tier === "standard" && includedLeft > 0) {
      includedLeft -= 1; // covered by the monthly bundle
    } else {
      credits += TIER_CREDIT_COST[tier];
    }
  }
  return credits;
}
