// US-1848: the tangible reward rail — milestone ladder, budget ceilings, the
// fulfiller registry, and the coverage gate that starts the loop.

import { assertEquals, assertNotEquals } from "@std/assert";

// Env BEFORE importing modules that touch the supabase client at import time.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  TANGIBLE_MILESTONES,
  DEFAULT_REWARD_BUDGET,
  budgetDecision,
  isFulfillable,
  milestonesForXp,
  monthStartIso,
  nextMilestoneForXp,
  normalizeRewardBudget,
} = await import("../lib/rewards-tangible.ts");
const { hasFullGradeCoverage } = await import("../lib/rewards-engine.ts");

import type { RewardBudget, RewardSpend } from "../lib/rewards-tangible.ts";

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

Deno.test("the discount reward types are typed but not yet fulfillable", () => {
  // The table and the budget rail carry them so US-1853 can add the Stripe work;
  // until a fulfiller is registered the engine refuses to grant them.
  assertEquals(isFulfillable("subscription_discount"), false);
  assertEquals(isFulfillable("per_grade_discount"), false);
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
