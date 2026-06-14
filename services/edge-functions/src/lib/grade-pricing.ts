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

// US-601: the premium authenticity / counterfeit-confidence add-on is offered
// only on the paid Premium/Express tiers — the higher per-tier charge covers it,
// so there is no separate billing path. Standard grades never include it. Pure +
// unit-tested; the route ALSO checks the seller opt-in + the feature flag.
export function tierSupportsAuthenticityAddon(tier: GradeTier): boolean {
  return tier === "premium" || tier === "express";
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

// Per-tier turnaround SLA (hours). Mirrors GRADETHREAD_TIERS.slaHours. Editable
// from admin via pricing_config (US-885); this is the compiled fallback.
export const TIER_SLA_HOURS: Record<GradeTier, number> = {
  standard: 48,
  premium: 12,
  express: 1,
};

export interface CreditPack {
  credits: number;
  priceCents: number;
}

// Credit packs, smallest → largest. Mirrors CREDIT_PACKS in src/lib/constants.ts.
// Editable from admin via pricing_config (US-885); this is the compiled fallback.
export const CREDIT_PACKS: readonly CreditPack[] = [
  { credits: 10, priceCents: 2499 },
  { credits: 25, priceCents: 5999 },
  { credits: 50, priceCents: 10999 },
  { credits: 100, priceCents: 19999 },
];

// Smallest credit pack from `packs` that satisfies the needed credit cost (upsell
// hint). `packs` must be sorted smallest → largest; falls back to the largest. A
// pure parametrized form of suggestPack so the live (DB) pack list can drive it.
export function suggestPackFrom(
  packs: readonly CreditPack[],
  creditCost: number,
): CreditPack | null {
  if (packs.length === 0) return null;
  for (const pack of packs) {
    if (creditCost <= pack.credits) return pack;
  }
  return packs[packs.length - 1];
}

// Smallest credit pack that satisfies the needed credit cost (upsell hint).
// Compiled-constant variant; the billing path uses suggestPackFrom with the live
// pricing_config packs (US-885).
export function suggestPack(creditCost: number): CreditPack {
  return suggestPackFrom(CREDIT_PACKS, creditCost) ?? { credits: 100, priceCents: 19999 };
}

// US-885 (AC#5): resolve the included-grade cap to enforce for the CURRENT
// billing period. On a fresh period (rolledOver) the live, possibly just-edited
// cap applies; within a period the snapshot taken at period start governs, so an
// admin changing a plan's included-grade count never retroactively grants or
// revokes grades in a period already in progress. A null snapshot (legacy /
// not-yet-reset row) falls back to the live cap. Pure + unit-tested.
export function resolveIncludedCap(
  snapshot: number | null | undefined,
  liveCap: number,
  rolledOver: boolean,
): number {
  if (rolledOver) return liveCap;
  return snapshot ?? liveCap;
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

// US-395: dunning grace. When a renewal payment fails the subscription goes
// `past_due` (mapSubscriptionStatus also folds Stripe's `unpaid` end-state into
// `past_due`). We keep paid caps during a grace window so a transient decline +
// a Stripe Smart-Retry success doesn't briefly demote a paying customer, but a
// PERMANENTLY-failing card loses paid caps once the window elapses (a
// `past_due` sub no longer entitles Pro forever). The defined dunning
// end-states both drop to Free here: `canceled` (NON_ENTITLING) and a
// past_due/`unpaid` subscription past the grace window. `now - past_due_since`.
export const PAST_DUE_GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export function effectivePlanFor(
  plan: string,
  subscriptionStatus: string | null,
  trialEndsAt?: string | null,
  now: Date = new Date(),
  pastDueSince?: string | null,
): string {
  if (subscriptionStatus === "paused") return "free";
  if (subscriptionStatus === "trialing") {
    // Expired trial → Free; an in-window trial keeps its trial plan.
    return trialEndsAt && new Date(trialEndsAt).getTime() <= now.getTime()
      ? "free"
      : plan;
  }
  if (subscriptionStatus === "past_due") {
    // Past the grace window → Free; still in grace → keep paid caps. With no
    // anchor recorded we fail OPEN (keep caps) — the anchor is set the moment
    // we record the first failed invoice (US-395 webhook change).
    if (pastDueSince && now.getTime() - new Date(pastDueSince).getTime() > PAST_DUE_GRACE_MS) {
      return "free";
    }
    return plan;
  }
  if (subscriptionStatus && NON_ENTITLING_STATUSES.has(subscriptionStatus)) {
    return "free";
  }
  return plan;
}

// US-395: compute the next users.past_due_since value across a status
// transition. The grace clock anchors at the FIRST failed payment and survives
// subsequent retries (so it actually elapses); it clears the moment billing
// recovers. Pure + exported for unit tests.
export function nextPastDueSince(
  prevStatus: string | null,
  prevPastDueSince: string | null,
  nextStatus: string,
  now: Date = new Date(),
): string | null {
  if (nextStatus === "past_due") {
    // Preserve the original anchor across retries; set it on the first entry.
    return prevStatus === "past_due" && prevPastDueSince
      ? prevPastDueSince
      : now.toISOString();
  }
  // Recovered to a good state → clear the clock. (canceled/paused/none are
  // non-entitling regardless, so the value is irrelevant there.)
  if (nextStatus === "active" || nextStatus === "trialing") return null;
  return prevPastDueSince ?? null;
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
