// US-1848: the tangible reward rail — milestone ladder, budget ceilings, the
// fulfiller registry, and the coverage gate that starts the loop.
// US-1853: the operator-editable catalog, the three trigger kinds, the
// per-milestone issue caps, and the discount entitlements.

import { assertEquals, assertNotEquals } from "@std/assert";

// Env BEFORE importing modules that touch the supabase client at import time.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  TANGIBLE_MILESTONES,
  DEFAULT_DISCOUNT_VALID_DAYS,
  DEFAULT_REWARD_BUDGET,
  activeDiscount,
  budgetDecision,
  couponParamsFor,
  discountedCents,
  grantExpiryIso,
  isFulfillable,
  isMilestoneUnlocked,
  milestoneCapDecision,
  milestoneFromRow,
  milestonesForXp,
  monthStartIso,
  nextMilestoneForXp,
  normalizeRewardBudget,
  rewardNotificationMessage,
  unlockedMilestones,
} = await import("../lib/rewards-tangible.ts");
const { hasFullGradeCoverage } = await import("../lib/rewards-engine.ts");

import type {
  MilestoneReward,
  MilestoneTriggerContext,
  RewardBudget,
  RewardSpend,
} from "../lib/rewards-tangible.ts";

const NO_SPEND: RewardSpend = {
  globalMonthUsd: 0,
  userMonthUsd: 0,
  userLifetimeUsd: 0,
};

// ─── Milestone ladder ───────────────────────────────────────────────────────

Deno.test("milestone keys are unique and thresholds strictly ascend", () => {
  const keys = new Set(TANGIBLE_MILESTONES.map((m) => m.key));
  assertEquals(keys.size, TANGIBLE_MILESTONES.length);
  for (let i = 1; i < TANGIBLE_MILESTONES.length; i++) {
    assertEquals(
      TANGIBLE_MILESTONES[i]!.xpThreshold > TANGIBLE_MILESTONES[i - 1]!.xpThreshold,
      true,
    );
  }
});

Deno.test("every catalogued milestone has a registered fulfiller", () => {
  // The guard against an inert promise: a milestone the engine would claim but
  // nothing could honour must never reach the catalog.
  for (const m of TANGIBLE_MILESTONES) {
    assertEquals(isFulfillable(m.rewardType), true, `${m.key} has no fulfiller`);
  }
});

Deno.test("US-1853 registered a fulfiller for every reward type", () => {
  // US-1848 shipped credits only and refused the two discounts, because a ledger
  // row nothing honours is an inert promise. Both are now honoured, so the
  // catalog is free to use them.
  assertEquals(isFulfillable("free_grade_credits"), true);
  assertEquals(isFulfillable("subscription_discount"), true);
  assertEquals(isFulfillable("per_grade_discount"), true);
});

Deno.test("milestonesForXp returns everything reached, lowest first", () => {
  assertEquals(milestonesForXp(0), []);
  assertEquals(milestonesForXp(899), []);
  assertEquals(milestonesForXp(900).map((m) => m.key), ["xp_900_credits_1"]);
  const at7k = milestonesForXp(7_000).map((m) => m.xpThreshold);
  assertEquals(at7k, [900, 2_500, 6_400]);
});

Deno.test("nextMilestoneForXp points at the next rung, null at the top", () => {
  assertEquals(nextMilestoneForXp(0)?.xpThreshold, 900);
  assertEquals(nextMilestoneForXp(900)?.xpThreshold, 2_500);
  const top = TANGIBLE_MILESTONES[TANGIBLE_MILESTONES.length - 1]!;
  assertEquals(nextMilestoneForXp(top.xpThreshold), null);
});

// ─── Budget ─────────────────────────────────────────────────────────────────

Deno.test("normalizeRewardBudget falls back on junk and honours real values", () => {
  assertEquals(normalizeRewardBudget(null), DEFAULT_REWARD_BUDGET);
  assertEquals(normalizeRewardBudget("nope"), DEFAULT_REWARD_BUDGET);
  assertEquals(
    normalizeRewardBudget({ monthly_usd_cap: -5, per_user_monthly_usd_cap: "x" }),
    DEFAULT_REWARD_BUDGET,
  );
  const custom = normalizeRewardBudget({
    monthly_usd_cap: 40,
    per_user_monthly_usd_cap: 2,
    per_user_lifetime_usd_cap: 9,
  });
  assertEquals(custom, {
    monthlyUsdCap: 40,
    perUserMonthlyUsdCap: 2,
    perUserLifetimeUsdCap: 9,
  });
});

Deno.test("a grant inside every ceiling is allowed", () => {
  assertEquals(budgetDecision(1, NO_SPEND, DEFAULT_REWARD_BUDGET), { allowed: true });
});

Deno.test("each ceiling refuses on its own, and the global one wins", () => {
  const budget: RewardBudget = {
    monthlyUsdCap: 10,
    perUserMonthlyUsdCap: 5,
    perUserLifetimeUsdCap: 8,
  };
  assertEquals(
    budgetDecision(1, { ...NO_SPEND, globalMonthUsd: 10 }, budget),
    { allowed: false, refusal: "global_monthly_cap" },
  );
  assertEquals(
    budgetDecision(1, { ...NO_SPEND, userMonthUsd: 5 }, budget),
    { allowed: false, refusal: "user_monthly_cap" },
  );
  assertEquals(
    budgetDecision(1, { ...NO_SPEND, userLifetimeUsd: 8 }, budget),
    { allowed: false, refusal: "user_lifetime_cap" },
  );
  // All three breached: the global cap is reported, because that is the one
  // that means "stop paying everyone", not "stop paying this account".
  assertEquals(
    budgetDecision(
      1,
      { globalMonthUsd: 10, userMonthUsd: 5, userLifetimeUsd: 8 },
      budget,
    ).refusal,
    "global_monthly_cap",
  );
});

Deno.test("a grant that lands exactly on a cap is allowed; one dollar over is not", () => {
  const budget: RewardBudget = {
    monthlyUsdCap: 10,
    perUserMonthlyUsdCap: 10,
    perUserLifetimeUsdCap: 10,
  };
  assertEquals(budgetDecision(4, { ...NO_SPEND, globalMonthUsd: 6 }, budget).allowed, true);
  assertEquals(budgetDecision(5, { ...NO_SPEND, globalMonthUsd: 6 }, budget).allowed, false);
});

/** Pay milestones in ladder order until a ceiling refuses. Returns USD paid. */
function walkLadder(budget: RewardBudget): number {
  const spend: RewardSpend = { ...NO_SPEND };
  let paid = 0;
  for (const m of TANGIBLE_MILESTONES) {
    if (!budgetDecision(m.costUsd, spend, budget).allowed) break;
    spend.globalMonthUsd += m.costUsd;
    spend.userMonthUsd += m.costUsd;
    spend.userLifetimeUsd += m.costUsd;
    paid += m.costUsd;
  }
  return paid;
}

Deno.test("the default caps are sized to let an honest user finish the ladder", () => {
  // The catalog and the ceilings have to be consistent, or the top rung is a
  // reward nobody can ever be paid. This is the check that catches a catalog
  // edit that quietly outgrows the budget it is spent from.
  const ladderTotal = TANGIBLE_MILESTONES.reduce((a, m) => a + m.costUsd, 0);
  assertEquals(ladderTotal <= DEFAULT_REWARD_BUDGET.perUserLifetimeUsdCap, true);
  assertEquals(walkLadder(DEFAULT_REWARD_BUDGET), ladderTotal);
});

Deno.test("a tightened lifetime cap stops the ladder mid-climb", () => {
  // The economics guarantee: whatever the catalog says, no account can take more
  // tangible value than the operator's ceiling allows.
  const tight: RewardBudget = { ...DEFAULT_REWARD_BUDGET, perUserLifetimeUsdCap: 2 };
  const paid = walkLadder(tight);
  assertEquals(paid <= 2, true);
  assertNotEquals(paid, TANGIBLE_MILESTONES.reduce((a, m) => a + m.costUsd, 0));
});

Deno.test("monthStartIso anchors on UTC month start", () => {
  assertEquals(
    monthStartIso(Date.parse("2026-08-07T23:30:00Z")),
    "2026-08-01T00:00:00.000Z",
  );
  assertEquals(
    monthStartIso(Date.parse("2026-01-01T00:00:00Z")),
    "2026-01-01T00:00:00.000Z",
  );
});

// ─── Coverage gate (where the loop starts) ──────────────────────────────────

const img = (t: string) => ({ image_type: t });

Deno.test("full coverage needs front + back + label + a detail", () => {
  assertEquals(
    hasFullGradeCoverage([img("front"), img("back"), img("label"), img("detail")]),
    true,
  );
  assertEquals(
    hasFullGradeCoverage([img("front"), img("back"), img("label"), img("detail_3")]),
    true,
  );
});

Deno.test("a minimum three-photo submission grades but earns no coverage XP", () => {
  assertEquals(hasFullGradeCoverage([img("front"), img("back"), img("label")]), false);
});

Deno.test("a missing required view fails coverage even with many details", () => {
  assertEquals(
    hasFullGradeCoverage([img("front"), img("label"), img("detail"), img("detail_2")]),
    false,
  );
  assertEquals(hasFullGradeCoverage([]), false);
});

Deno.test("a defect or measurement shot does not stand in for a detail", () => {
  assertEquals(
    hasFullGradeCoverage([
      img("front"),
      img("back"),
      img("label"),
      img("defect"),
      img("measurement_chest"),
    ]),
    false,
  );
});

// ─── US-1853: triggers ──────────────────────────────────────────────────────

function milestone(over: Partial<MilestoneReward> = {}): MilestoneReward {
  return {
    key: "m",
    triggerType: "xp_threshold",
    xpThreshold: 100,
    triggerKey: null,
    rewardType: "free_grade_credits",
    value: 1,
    costUsd: 0.35,
    label: "1 free grade",
    discountDurationMonths: null,
    discountValidDays: null,
    monthlyGrantCap: null,
    lifetimeGrantCap: null,
    ...over,
  };
}

function ctx(over: Partial<MilestoneTriggerContext> = {}): MilestoneTriggerContext {
  return {
    xpTotal: 0,
    badgeKeys: new Set<string>(),
    seasonGoalKeys: new Set<string>(),
    ...over,
  };
}

Deno.test("each trigger kind fires only on its own signal", () => {
  const xp = milestone({ triggerType: "xp_threshold", xpThreshold: 900 });
  assertEquals(isMilestoneUnlocked(xp, ctx({ xpTotal: 899 })), false);
  assertEquals(isMilestoneUnlocked(xp, ctx({ xpTotal: 900 })), true);

  const badge = milestone({ triggerType: "badge", triggerKey: "grades_100" });
  assertEquals(isMilestoneUnlocked(badge, ctx({ xpTotal: 10_000_000 })), false);
  assertEquals(
    isMilestoneUnlocked(badge, ctx({ badgeKeys: new Set(["grades_100"]) })),
    true,
  );

  const season = milestone({ triggerType: "season_goal", triggerKey: "full_coverage" });
  assertEquals(
    isMilestoneUnlocked(season, ctx({ badgeKeys: new Set(["full_coverage"]) })),
    false,
  );
  assertEquals(
    isMilestoneUnlocked(season, ctx({ seasonGoalKeys: new Set(["full_coverage"]) })),
    true,
  );
});

Deno.test("a badge/season milestone with no key can never fire", () => {
  // The DB CHECK forbids it, but a row that predates the constraint (or a bad
  // hand-write) must not be treated as unlocked-for-everyone.
  const orphan = milestone({ triggerType: "badge", triggerKey: null });
  assertEquals(isMilestoneUnlocked(orphan, ctx({ badgeKeys: new Set([""]) })), false);
});

Deno.test("unlocked milestones come back cheapest-first", () => {
  // The engine stops at the first budget refusal, so ordering by cost is what
  // stops one expensive rung starving every cheap one behind it.
  const out = unlockedMilestones(
    [
      milestone({ key: "big", costUsd: 7, xpThreshold: 10 }),
      milestone({ key: "small", costUsd: 0.35, xpThreshold: 10 }),
      milestone({ key: "locked", costUsd: 0.1, xpThreshold: 10_000 }),
    ],
    ctx({ xpTotal: 50 }),
  );
  assertEquals(out.map((m) => m.key), ["small", "big"]);
});

// ─── US-1853: per-milestone issue caps ──────────────────────────────────────

Deno.test("an uncapped milestone is never refused by the cap check", () => {
  assertEquals(
    milestoneCapDecision(milestone(), { monthCount: 9_999, lifetimeCount: 9_999 }),
    { allowed: true },
  );
});

Deno.test("the monthly and lifetime issue caps each refuse on their own", () => {
  const m = milestone({ monthlyGrantCap: 2, lifetimeGrantCap: 5 });
  assertEquals(milestoneCapDecision(m, { monthCount: 1, lifetimeCount: 1 }).allowed, true);
  assertEquals(
    milestoneCapDecision(m, { monthCount: 2, lifetimeCount: 2 }),
    { allowed: false, refusal: "milestone_monthly_cap" },
  );
  assertEquals(
    milestoneCapDecision(m, { monthCount: 0, lifetimeCount: 5 }),
    { allowed: false, refusal: "milestone_lifetime_cap" },
  );
});

// ─── US-1853: discounts ─────────────────────────────────────────────────────

Deno.test("a per-grade discount expires; a subscription discount does not", () => {
  const now = Date.parse("2026-08-07T00:00:00Z");
  const perGrade = milestone({ rewardType: "per_grade_discount", discountValidDays: 30 });
  assertEquals(grantExpiryIso(perGrade, now), "2026-09-06T00:00:00.000Z");
  // No window configured → the default, not "forever".
  const defaulted = milestone({ rewardType: "per_grade_discount" });
  assertEquals(
    grantExpiryIso(defaulted, now),
    new Date(now + DEFAULT_DISCOUNT_VALID_DAYS * 86_400_000).toISOString(),
  );
  assertEquals(grantExpiryIso(milestone({ rewardType: "subscription_discount" }), now), null);
  assertEquals(grantExpiryIso(milestone(), now), null);
});

Deno.test("a per-grade coupon is always duration:once — Stripe refuses anything else on a one-off charge", () => {
  const now = Date.parse("2026-08-07T00:00:00Z");
  const perGrade = couponParamsFor(
    milestone({ rewardType: "per_grade_discount", value: 15, discountValidDays: 30 }),
    now,
  );
  assertEquals(perGrade.duration, "once");
  assertEquals(perGrade.percentOff, 15);
  assertEquals(perGrade.redeemByMs, Date.parse("2026-09-06T00:00:00.000Z"));

  const repeating = couponParamsFor(
    milestone({
      rewardType: "subscription_discount",
      value: 20,
      discountDurationMonths: 3,
    }),
    now,
  );
  assertEquals(repeating.duration, "repeating");
  assertEquals(repeating.durationInMonths, 3);
  // A user-specific coupon must not be redeemable by anyone else.
  assertEquals(repeating.maxRedemptions, 1);

  const single = couponParamsFor(
    milestone({ rewardType: "subscription_discount", value: 20, discountDurationMonths: 1 }),
    now,
  );
  assertEquals(single.duration, "once");
});

const NOW = Date.parse("2026-08-07T00:00:00Z");

function grantRow(over: Record<string, unknown> = {}) {
  return {
    milestone_key: "m",
    reward_type: "per_grade_discount",
    reward_value: 10,
    expires_at: null,
    consumed_at: null,
    metadata: { stripe_coupon_id: "co_test" },
    ...over,
  } as never;
}

Deno.test("the biggest live discount wins", () => {
  const picked = activeDiscount(
    [
      grantRow({ milestone_key: "small", reward_value: 10 }),
      grantRow({ milestone_key: "big", reward_value: 25 }),
    ],
    "per_grade_discount",
    NOW,
  );
  assertEquals(picked?.milestoneKey, "big");
  assertEquals(picked?.percentOff, 25);
});

Deno.test("expired, consumed, wrong-type and couponless grants are all skipped", () => {
  assertEquals(
    activeDiscount([grantRow({ expires_at: "2026-08-06T00:00:00Z" })], "per_grade_discount", NOW),
    null,
  );
  assertEquals(
    activeDiscount([grantRow({ consumed_at: "2026-08-01T00:00:00Z" })], "per_grade_discount", NOW),
    null,
  );
  assertEquals(
    activeDiscount([grantRow()], "subscription_discount", NOW),
    null,
  );
  // A grant whose fulfilment never recorded a coupon can't be applied to a
  // checkout, so it must not be reported as an available discount.
  assertEquals(activeDiscount([grantRow({ metadata: {} })], "per_grade_discount", NOW), null);
});

Deno.test("discountedCents rounds to whole cents and never goes negative", () => {
  assertEquals(discountedCents(1999, 15), 1699);
  assertEquals(discountedCents(1999, 0), 1999);
  assertEquals(discountedCents(1999, 100), 0);
  assertEquals(discountedCents(0, 50), 0);
});

// ─── US-1853: catalog rows ──────────────────────────────────────────────────

const ROW = {
  key: "xp_900_credits_1",
  label: "1 free grade",
  reward_type: "free_grade_credits",
  trigger_type: "xp_threshold",
  xp_threshold: 900,
  trigger_key: null,
  reward_value: "1",
  cost_usd: "0.35",
  discount_duration_months: null,
  discount_valid_days: null,
  monthly_grant_cap: null,
  lifetime_grant_cap: null,
};

Deno.test("a catalog row maps onto the engine's shape, numerics coerced", () => {
  const m = milestoneFromRow(ROW as never);
  assertEquals(m?.value, 1);
  assertEquals(m?.costUsd, 0.35);
  assertEquals(m?.triggerType, "xp_threshold");
});

Deno.test("an unusable catalog row is dropped, not guessed at", () => {
  // Each of these would otherwise become a milestone that pays the wrong thing
  // or unlocks for everyone.
  assertEquals(milestoneFromRow({ ...ROW, reward_type: "free_beer" } as never), null);
  assertEquals(milestoneFromRow({ ...ROW, trigger_type: "vibes" } as never), null);
  assertEquals(milestoneFromRow({ ...ROW, reward_value: "0" } as never), null);
  assertEquals(milestoneFromRow({ ...ROW, xp_threshold: null } as never), null);
  assertEquals(
    milestoneFromRow(
      { ...ROW, trigger_type: "badge", xp_threshold: null, trigger_key: null } as never,
    ),
    null,
  );
});

Deno.test("the unlock notification matches the trigger that fired", () => {
  assertEquals(
    rewardNotificationMessage(milestone({ xpThreshold: 900 })),
    "You hit 900 XP — 1 free grade added to your account.",
  );
  // A badge reward must not claim an XP threshold the user never crossed.
  const badge = milestone({
    triggerType: "badge",
    triggerKey: "grades_100",
    rewardType: "subscription_discount",
    label: "20% off your next 3 months",
  });
  assertEquals(
    rewardNotificationMessage(badge),
    "You hit a rewards milestone — 20% off your next 3 months is ready to use.",
  );
});
