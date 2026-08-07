// US-1858: the economics guardrails around the tangible reward rail.
//
// Everything asserted here is PURE, which is the point: the policy that decides
// whether real money leaves has to be checkable without a DB, a Stripe key or a
// clock. The impure halves (loadUnitEconomics / loadVelocityUsage /
// recordBudgetBreach) are thin reads over these decisions.

import { assertEquals } from "@std/assert";

// Env BEFORE importing modules that touch the supabase client at import time —
// rewards-economics.ts pulls in lib/supabase.ts, which throws at import without
// it. A static import would run before these lines, so the values are pulled in
// dynamically below.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  breachScopeLabel,
  DEFAULT_REWARD_GUARDRAILS,
  effectivePerUserMonthlyCap,
  guardrailsToSetting,
  isBreachScope,
  isPlatformScope,
  marginHeadroomUsd,
  normalizeRewardGuardrails,
  planMonthlyRevenueUsd,
  reconcileGrants,
  summarizeRoi,
  velocityDecision,
} = await import("../lib/rewards-economics.ts");
const { BREACH_SCOPE_FOR_REFUSAL } = await import("../lib/rewards-tangible.ts");

import type {
  CreditLedgerRow,
  GrantLedgerRow,
  RewardGuardrails,
} from "../lib/rewards-economics.ts";
import type { RewardBudget } from "../lib/rewards-tangible.ts";

const BUDGET: RewardBudget = {
  monthlyUsdCap: 500,
  perUserMonthlyUsdCap: 15,
  perUserLifetimeUsdCap: 60,
};

// ── Config normalisation ────────────────────────────────────────────────────

Deno.test("normalizeRewardGuardrails falls back on junk", () => {
  const g = normalizeRewardGuardrails({ margin_floor_pct: "nope", fraud_hold_enabled: 1 });
  assertEquals(g.marginFloorPct, DEFAULT_REWARD_GUARDRAILS.marginFloorPct);
  assertEquals(g.fraudHoldEnabled, DEFAULT_REWARD_GUARDRAILS.fraudHoldEnabled);
});

Deno.test("normalizeRewardGuardrails CLAMPS rather than trusting", () => {
  // The classic typo: 40 meaning 40%. Unclamped it reads as 4000% and refuses
  // every grant forever, with no clue why.
  const g = normalizeRewardGuardrails({
    margin_floor_pct: 40,
    per_user_daily_grant_cap: -5,
    per_user_daily_usd_cap: 9_999_999,
  });
  assertEquals(g.marginFloorPct, 0.95);
  assertEquals(g.perUserDailyGrantCap, 0);
  assertEquals(g.perUserDailyUsdCap, 10_000);
});

Deno.test("guardrailsToSetting round-trips through normalize", () => {
  const g: RewardGuardrails = {
    marginFloorPct: 0.5,
    freeTierMonthlyUsdCap: 3,
    perUserDailyGrantCap: 2,
    perUserDailyUsdCap: 4,
    autoKillOnGlobalBreach: false,
    fraudHoldEnabled: false,
  };
  assertEquals(normalizeRewardGuardrails(guardrailsToSetting(g)), g);
});

// ── Margin floor ────────────────────────────────────────────────────────────

Deno.test("planMonthlyRevenueUsd resolves unknown plans to the free tier", () => {
  assertEquals(planMonthlyRevenueUsd("business"), 99);
  assertEquals(planMonthlyRevenueUsd("PRO"), 59);
  assertEquals(planMonthlyRevenueUsd(null), 0);
  assertEquals(planMonthlyRevenueUsd("enterprise_2027"), 0);
});

Deno.test("marginHeadroomUsd leaves the floor intact", () => {
  // $99 plan, 40% floor ⇒ $59.40 is spendable; $10 of AI already spent leaves
  // $49.40 before any reward, and $5 of reward leaves $44.40.
  const headroom = marginHeadroomUsd(
    { planMonthlyUsd: 99, aiCostMonthUsd: 10, rewardCostMonthUsd: 5 },
    DEFAULT_REWARD_GUARDRAILS,
  );
  assertEquals(Math.round(headroom * 100) / 100, 44.4);
});

Deno.test("marginHeadroomUsd never goes negative", () => {
  const headroom = marginHeadroomUsd(
    { planMonthlyUsd: 29, aiCostMonthUsd: 40, rewardCostMonthUsd: 0 },
    DEFAULT_REWARD_GUARDRAILS,
  );
  assertEquals(headroom, 0);
});

Deno.test("a free account gets the flat acquisition allowance, not zero", () => {
  // The margin formula would give a zero-revenue account exactly nothing, which
  // would mean no free user is ever rewarded — and turning a free user into a
  // paying one is what the ladder is for.
  const g = { ...DEFAULT_REWARD_GUARDRAILS, freeTierMonthlyUsdCap: 2 };
  assertEquals(
    marginHeadroomUsd({ planMonthlyUsd: 0, aiCostMonthUsd: 12, rewardCostMonthUsd: 0.5 }, g),
    1.5,
  );
});

Deno.test("effectivePerUserMonthlyCap only ever NARROWS the flat cap", () => {
  // A free account: $2 allowance is far below the $15 flat cap, so it binds.
  assertEquals(
    effectivePerUserMonthlyCap(
      BUDGET,
      { planMonthlyUsd: 0, aiCostMonthUsd: 0, rewardCostMonthUsd: 0 },
      DEFAULT_REWARD_GUARDRAILS,
    ),
    2,
  );
  // A Business account has $59.40 of headroom — far MORE than the flat cap, and
  // the flat cap still wins. A guardrail that widened a budget would not be one.
  assertEquals(
    effectivePerUserMonthlyCap(
      BUDGET,
      { planMonthlyUsd: 99, aiCostMonthUsd: 0, rewardCostMonthUsd: 0 },
      DEFAULT_REWARD_GUARDRAILS,
    ),
    15,
  );
});

Deno.test("effectivePerUserMonthlyCap is a CUMULATIVE cap, so it composes", () => {
  // budgetDecision compares spend + cost against the cap, so the headroom has to
  // be expressed relative to what has already been spent this month.
  const cap = effectivePerUserMonthlyCap(
    BUDGET,
    { planMonthlyUsd: 0, aiCostMonthUsd: 0, rewardCostMonthUsd: 1.5 },
    { ...DEFAULT_REWARD_GUARDRAILS, freeTierMonthlyUsdCap: 2 },
  );
  assertEquals(cap, 2);
});

// ── Velocity ────────────────────────────────────────────────────────────────

Deno.test("velocityDecision refuses too many grants in a day", () => {
  const g = { ...DEFAULT_REWARD_GUARDRAILS, perUserDailyGrantCap: 3, perUserDailyUsdCap: 100 };
  assertEquals(velocityDecision(0.35, { grantsToday: 2, usdToday: 1 }, g).allowed, true);
  const refused = velocityDecision(0.35, { grantsToday: 3, usdToday: 1 }, g);
  assertEquals(refused.allowed, false);
  assertEquals(refused.refusal, "velocity_grant_cap");
});

Deno.test("velocityDecision refuses too much value in a day", () => {
  const g = { ...DEFAULT_REWARD_GUARDRAILS, perUserDailyGrantCap: 100, perUserDailyUsdCap: 5 };
  const refused = velocityDecision(1.5, { grantsToday: 1, usdToday: 4 }, g);
  assertEquals(refused.allowed, false);
  assertEquals(refused.refusal, "velocity_usd_cap");
});

Deno.test("a zero velocity cap means NO limit, not a total stop", () => {
  // An operator who wants nothing granted has the kill-switch. Reading a blank
  // config field as "grant nothing" is the guardrail that takes the rail down at
  // 3am for a reason nobody can see.
  const g = { ...DEFAULT_REWARD_GUARDRAILS, perUserDailyGrantCap: 0, perUserDailyUsdCap: 0 };
  assertEquals(velocityDecision(99, { grantsToday: 500, usdToday: 500 }, g).allowed, true);
});

// ── Breach scopes ───────────────────────────────────────────────────────────

Deno.test("every budget refusal maps to a breach scope", () => {
  assertEquals(BREACH_SCOPE_FOR_REFUSAL.global_monthly_cap, "global_monthly");
  assertEquals(BREACH_SCOPE_FOR_REFUSAL.user_monthly_cap, "user_monthly");
  assertEquals(BREACH_SCOPE_FOR_REFUSAL.user_lifetime_cap, "user_lifetime");
  for (const scope of Object.values(BREACH_SCOPE_FOR_REFUSAL)) {
    assertEquals(isBreachScope(scope), true);
    // Every scope must render — a missing label would print "undefined" on the
    // console at exactly the moment someone is reading it in an incident.
    assertEquals(breachScopeLabel(scope).length > 0, true);
  }
});

Deno.test("only the platform scope can pause the whole rail", () => {
  assertEquals(isPlatformScope("global_monthly"), true);
  assertEquals(isPlatformScope("user_monthly"), false);
  assertEquals(isPlatformScope("velocity"), false);
});

// ── ROI ─────────────────────────────────────────────────────────────────────

Deno.test("summarizeRoi divides spend across attributed signups", () => {
  const roi = summarizeRoi({ rewardSpendUsd: 40, referralSignups: 6, shareSignups: 2 });
  assertEquals(roi.attributedSignups, 8);
  assertEquals(roi.costPerSignupUsd, 5);
});

Deno.test("summarizeRoi reports NULL, not zero, when nothing converted", () => {
  // "$40 and nobody" and "nothing spent" are different situations, and a 0 would
  // sort to the top of an ascending cost-per-signup column as the best result.
  const roi = summarizeRoi({ rewardSpendUsd: 40, referralSignups: 0, shareSignups: 0 });
  assertEquals(roi.attributedSignups, 0);
  assertEquals(roi.costPerSignupUsd, null);
});

// ── Reconciliation ──────────────────────────────────────────────────────────

function grant(over: Partial<GrantLedgerRow>): GrantLedgerRow {
  return {
    id: "g1",
    user_id: "u1",
    milestone_key: "xp_900_credits_1",
    reward_type: "free_grade_credits",
    reward_value: 1,
    cost_usd: 0.35,
    granted_at: "2026-08-01T00:00:00.000Z",
    metadata: {},
    ...over,
  };
}

const CREDIT_ROW: CreditLedgerRow = {
  user_id: "u1",
  delta: 1,
  notes: "Rewards milestone: 1 free grade (xp_900_credits_1)",
  created_at: "2026-08-01T00:00:00.000Z",
};

Deno.test("a credit grant with a matching ledger row reconciles", () => {
  const r = reconcileGrants([grant({})], [CREDIT_ROW], null);
  assertEquals(r.checked, 1);
  assertEquals(r.matched, 1);
  assertEquals(r.findings.length, 0);
});

Deno.test("a credit grant with no ledger row is a finding", () => {
  const r = reconcileGrants([grant({})], [], null);
  assertEquals(r.matched, 0);
  assertEquals(r.findings[0]?.issue, "missing_credit_ledger");
});

Deno.test("a credit grant whose ledger delta disagrees is a finding", () => {
  const r = reconcileGrants([grant({ reward_value: 3 })], [CREDIT_ROW], null);
  assertEquals(r.findings[0]?.issue, "credit_amount_mismatch");
  assertEquals(r.findings[0]?.expected, 3);
  assertEquals(r.findings[0]?.actual, 1);
});

Deno.test("another account's identical grant does not satisfy this one", () => {
  const r = reconcileGrants([grant({ user_id: "u2" })], [CREDIT_ROW], null);
  assertEquals(r.findings[0]?.issue, "missing_credit_ledger");
});

Deno.test("a discount grant with no coupon id is a finding", () => {
  const r = reconcileGrants(
    [grant({ reward_type: "subscription_discount", reward_value: 20, metadata: {} })],
    [],
    null,
  );
  assertEquals(r.findings[0]?.issue, "missing_coupon");
});

Deno.test("a discount grant whose coupon vanished from Stripe is a finding", () => {
  const g = grant({
    reward_type: "per_grade_discount",
    reward_value: 25,
    metadata: { stripe_coupon_id: "co_gone" },
  });
  const r = reconcileGrants([g], [], new Set(["co_other"]));
  assertEquals(r.findings[0]?.issue, "coupon_not_found");
});

Deno.test("an UNREACHABLE Stripe reports no coupon findings at all", () => {
  // NULL is not an empty set. A network blip must not be shown to an operator as
  // every payout having never happened.
  const g = grant({
    reward_type: "per_grade_discount",
    reward_value: 25,
    metadata: { stripe_coupon_id: "co_gone" },
  });
  const r = reconcileGrants([g], [], null);
  assertEquals(r.matched, 1);
  assertEquals(r.findings.length, 0);
});
