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

// Resolve the plan that governs included grades + caps, accounting for a paused
// subscription and an EXPIRED TRIAL both falling back to Free.
//
// US-383: handle_new_user grants a 14-day Pro trial (subscription_status
// 'trialing', trial_ends_at +14d) but never creates a Stripe subscription. Once
// the trial lapses, the daily downgrade job flips the row to free/none — but
// until that job runs we must NOT keep handing out Pro caps to a signup that
// never added a card. So an expired trial reads as Free here immediately,
// independent of the job. `now` is injectable for tests.
// US-392: subscription statuses that must NOT entitle paid plan caps. A paid
// flipdesk_plan only ever comes from a real Stripe subscription — admins cannot
// grant one cardless (admin-billing.ts refuses free→paid without a card) — so a
// paid plan paired with any of these is an unpaid/lapsed sub (notably the
// `incomplete` state, mapped to 'none') and drops to Free until a verified-paid
// signal (invoice.payment_succeeded → 'active') arrives. `null` is treated as
// entitling for backward-compatibility (the column is NOT NULL in practice).
const NON_ENTITLING_STATUSES = new Set(["none", "canceled", "incomplete"]);

export function effectivePlanFor(
  plan: string,
  subscriptionStatus: string | null,
  trialEndsAt?: string | null,
  now: Date = new Date(),
): string {
  if (subscriptionStatus === "paused") return "free";
  if (subscriptionStatus === "trialing") {
    // Expired trial → Free; an in-window trial keeps its trial plan.
    return trialEndsAt && new Date(trialEndsAt).getTime() <= now.getTime()
      ? "free"
      : plan;
  }
  if (subscriptionStatus && NON_ENTITLING_STATUSES.has(subscriptionStatus)) {
    return "free";
  }
  return plan;
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
