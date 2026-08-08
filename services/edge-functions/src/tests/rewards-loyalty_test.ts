// US-1914: the loyalty policy, tested where it lives — in the pure half.
//
// Everything asserted here is a PROMISE the feature makes rather than an
// implementation detail, and the promises are unusually load-bearing because
// they are all negative: standing never decays, an anniversary is never paid
// twice, a multiplier never shrinks a reward, and a budget cap never silently
// widens. A negative property is one nothing goes red about when it breaks,
// which is exactly why each one gets a case.
//
// The DB half is deliberately untested — it is thin, and testing it would mean
// mocking PostgREST rather than checking a rule.

import { assertEquals } from "@std/assert";

// The env dance is NOT cosmetic: both modules under test import lib/supabase.ts
// transitively, which throws `SUPABASE_URL is not set` at MODULE EVALUATION. A
// static top-of-file import runs before any statement here, so the env is set
// first and the modules are pulled in dynamically. The full `deno test` suite
// MASKS this (one process; an alphabetically-earlier test already set it), so a
// file written the obvious way passes in CI and dies when run alone. `??`
// defaults so a real value in the shell is never clobbered.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

const {
  anniversaryBaseKey,
  anniversaryDue,
  anniversaryInstanceKey,
  applyTenureMultiplier,
  ascendOnly,
  completedYears,
  creditMultiplierFor,
  DEFAULT_LOYALTY_CONFIG,
  DEFAULT_TENURE_TIERS,
  deriveTenureTier,
  monthsSince,
  nextAnniversaryMs,
  nextTenureTier,
  normalizeLoyaltyConfig,
  ordinalYear,
} = await import("../lib/rewards-loyalty.ts");
type TenureTier = import("../lib/rewards-loyalty.ts").TenureTier;

const { applyLoyaltyToCatalog, isMilestoneUnlocked } = await import(
  "../lib/rewards-tangible.ts"
);
type MilestoneReward = import("../lib/rewards-tangible.ts").MilestoneReward;

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-07T12:00:00.000Z");

function tier(over: Partial<TenureTier> = {}): TenureTier {
  return {
    key: "year_one",
    label: "One year in",
    blurb: "",
    rank: 1,
    minMonths: 12,
    minPaidMonths: 3,
    creditMultiplier: 1.1,
    ...over,
  };
}

// ─── Month + year math ──────────────────────────────────────────────────────

Deno.test("monthsSince does not count a month until the day comes round", () => {
  const from = Date.parse("2026-01-28T00:00:00.000Z");
  assertEquals(monthsSince(from, Date.parse("2026-02-27T00:00:00.000Z")), 0);
  assertEquals(monthsSince(from, Date.parse("2026-02-28T00:00:00.000Z")), 1);
  // Never negative, however confused the clock is.
  assertEquals(monthsSince(from, Date.parse("2025-01-01T00:00:00.000Z")), 0);
});

Deno.test("completedYears counts anniversaries, not rounded age", () => {
  const from = Date.parse("2023-08-07T00:00:00.000Z");
  assertEquals(completedYears(from, Date.parse("2026-08-06T00:00:00.000Z")), 2);
  assertEquals(completedYears(from, Date.parse("2026-08-07T00:00:00.000Z")), 3);
});

// ─── The ladder ─────────────────────────────────────────────────────────────

Deno.test("a tier needs BOTH tenure and paid months", () => {
  // Three years on the platform, never paid: still rank 0.
  assertEquals(deriveTenureTier(36, 0)?.key, "newcomer");
  // Paid heavily, one month in: also rank 0. Money does not buy tenure.
  assertEquals(deriveTenureTier(1, 40)?.key, "newcomer");
  assertEquals(deriveTenureTier(24, 9)?.key, "year_two");
});

Deno.test("ascendOnly is the never-decay promise", () => {
  const tiers = DEFAULT_TENURE_TIERS;
  // The derived tier collapses (a raised threshold, a failed paid-months read)
  // but the held peak wins.
  const derived = deriveTenureTier(36, 0, tiers);
  assertEquals(derived?.rank, 0);
  assertEquals(ascendOnly(derived, 3, tiers)?.key, "veteran");
  // A genuine promotion still goes through.
  assertEquals(ascendOnly(deriveTenureTier(36, 18, tiers), 1, tiers)?.key, "veteran");
  // A peak nothing on the live ladder matches falls back to the highest tier at
  // or below it, rather than dropping the standing entirely.
  assertEquals(ascendOnly(null, 99, tiers)?.key, "veteran");
});

Deno.test("nextTenureTier walks up and stops at the top", () => {
  assertEquals(nextTenureTier(null)?.key, "newcomer");
  assertEquals(nextTenureTier(tier({ rank: 0 }))?.key, "year_one");
  assertEquals(nextTenureTier(tier({ rank: 3 })), null);
});

// ─── The multiplier ─────────────────────────────────────────────────────────

Deno.test("the multiplier is switchable off and can never fall below 1", () => {
  const off = { ...DEFAULT_LOYALTY_CONFIG, multiplierEnabled: false };
  assertEquals(creditMultiplierFor(tier({ creditMultiplier: 1.35 }), off), 1);
  const paused = { ...DEFAULT_LOYALTY_CONFIG, enabled: false };
  assertEquals(creditMultiplierFor(tier({ creditMultiplier: 1.35 }), paused), 1);
  // A hand-built tier below 1 (the DB CHECK cannot reach the fallback ladder or
  // a test fixture) is clamped rather than honoured as a penalty.
  assertEquals(creditMultiplierFor(tier({ creditMultiplier: 0.5 }), DEFAULT_LOYALTY_CONFIG), 1);
  assertEquals(creditMultiplierFor(null, DEFAULT_LOYALTY_CONFIG), 1);
});

Deno.test("the multiplier scales COST with value, so the budget caps still bind", () => {
  const scaled = applyTenureMultiplier(
    { rewardType: "free_grade_credits", value: 10, costUsd: 3.5 },
    1.35,
  );
  assertEquals(scaled.value, 14);
  // 3.50 / 10 × 14 = 4.90. A multiplier that grew the gift but not this number
  // would make every USD ceiling 35% larger than the operator set it.
  assertEquals(scaled.costUsd, 4.9);
});

Deno.test("the multiplier never touches a discount", () => {
  const pct = { rewardType: "subscription_discount", value: 20, costUsd: 12 };
  assertEquals(applyTenureMultiplier(pct, 1.35), pct);
  const perGrade = { rewardType: "per_grade_discount", value: 15, costUsd: 3 };
  assertEquals(applyTenureMultiplier(perGrade, 2), perGrade);
});

Deno.test("a multiplier too small to move a 1-credit reward changes nothing", () => {
  const one = { rewardType: "free_grade_credits", value: 1, costUsd: 0.35 };
  // round(1 × 1.1) = 1, so value is unchanged — and so is cost. A cost that
  // moved while the reward did not would be a charge for nothing.
  assertEquals(applyTenureMultiplier(one, 1.1), one);
});

// ─── Anniversaries ──────────────────────────────────────────────────────────

Deno.test("anniversaryDue fires once, inside the window, and never back-pays", () => {
  const memberSince = Date.parse("2023-08-01T00:00:00.000Z");
  const cfg = DEFAULT_LOYALTY_CONFIG;

  // Year 3 landed six days ago — inside the 14-day window, not yet celebrated.
  assertEquals(anniversaryDue(memberSince, 2, NOW, cfg)?.year, 3);
  // Already celebrated: nothing owed.
  assertEquals(anniversaryDue(memberSince, 3, NOW, cfg), null);
  // Window lapsed (the sweep was down a month): not paid late.
  assertEquals(anniversaryDue(memberSince, 2, NOW + 40 * DAY, cfg), null);
  // An eight-year account at year 0 is owed year 8 only, never years 1–7.
  const old = Date.parse("2018-08-01T00:00:00.000Z");
  assertEquals(anniversaryDue(old, 0, NOW, cfg)?.year, 8);
  // Under a year: nothing.
  assertEquals(anniversaryDue(Date.parse("2026-03-01T00:00:00.000Z"), 0, NOW, cfg), null);
});

Deno.test("the anniversary switch pauses without consuming the year", () => {
  const memberSince = Date.parse("2023-08-01T00:00:00.000Z");
  const paused = { ...DEFAULT_LOYALTY_CONFIG, anniversaryEnabled: false };
  assertEquals(anniversaryDue(memberSince, 2, NOW, paused), null);
  const off = { ...DEFAULT_LOYALTY_CONFIG, enabled: false };
  assertEquals(anniversaryDue(memberSince, 2, NOW, off), null);
});

Deno.test("nextAnniversaryMs always points forward", () => {
  const memberSince = Date.parse("2023-08-01T00:00:00.000Z");
  const next = nextAnniversaryMs(memberSince, NOW);
  assertEquals(next > NOW, true);
  assertEquals(new Date(next).toISOString().slice(0, 10), "2027-08-01");
});

Deno.test("instance keys round-trip and are per-year", () => {
  const k = anniversaryInstanceKey("anniversary_gift", 3);
  assertEquals(k, "anniversary_gift:y3");
  assertEquals(anniversaryBaseKey(k), "anniversary_gift");
  // A plain key is its own base — the milestone view relies on this.
  assertEquals(anniversaryBaseKey("xp_900_credits_1"), "xp_900_credits_1");
  // Different years are different grant keys, which is the whole reason
  // UNIQUE (user_id, milestone_key) can mean "once a year" here.
  assertEquals(k === anniversaryInstanceKey("anniversary_gift", 4), false);
});

Deno.test("ordinalYear reads like English, including the teens", () => {
  assertEquals(ordinalYear(1), "1st");
  assertEquals(ordinalYear(2), "2nd");
  assertEquals(ordinalYear(3), "3rd");
  assertEquals(ordinalYear(4), "4th");
  assertEquals(ordinalYear(11), "11th");
  assertEquals(ordinalYear(21), "21st");
});

// ─── The catalog transform (the bridge into the tangible rail) ──────────────

function anniversaryMilestone(): MilestoneReward {
  return {
    key: "anniversary_gift",
    baseKey: "anniversary_gift",
    triggerType: "anniversary",
    xpThreshold: 0,
    triggerKey: "account",
    rewardType: "free_grade_credits",
    value: 2,
    costUsd: 0.7,
    label: "Anniversary free grade",
    discountDurationMonths: null,
    discountValidDays: null,
    monthlyGrantCap: null,
    lifetimeGrantCap: null,
  };
}

function xpMilestone(): MilestoneReward {
  return {
    ...anniversaryMilestone(),
    key: "xp_900_credits_1",
    baseKey: "xp_900_credits_1",
    triggerType: "xp_threshold",
    xpThreshold: 900,
    triggerKey: null,
    value: 10,
    costUsd: 3.5,
    label: "10 free grades",
  };
}

Deno.test("an anniversary entry with no year owed is DROPPED, not left claimable", () => {
  // Left in with its bare catalog key it would be granted once and never again,
  // quietly turning an annual gift into a one-off.
  const out = applyLoyaltyToCatalog([anniversaryMilestone(), xpMilestone()], 0, 1);
  assertEquals(out.map((m) => m.key), ["xp_900_credits_1"]);
});

Deno.test("applyLoyaltyToCatalog instances the year and keeps the base key", () => {
  const [gift] = applyLoyaltyToCatalog([anniversaryMilestone()], 3, 1);
  assertEquals(gift.key, "anniversary_gift:y3");
  // baseKey is what the per-milestone issue caps count on — if instancing lost
  // it, an operator's lifetime ceiling would reset every anniversary.
  assertEquals(gift.baseKey, "anniversary_gift");
  assertEquals(gift.label, "Anniversary free grade — year 3");
});

Deno.test("the multiplier reaches the anniversary gift too", () => {
  const [gift] = applyLoyaltyToCatalog([anniversaryMilestone()], 2, 1.35);
  // round(2 × 1.35) = 3, cost 0.70/2 × 3 = 1.05.
  assertEquals(gift.value, 3);
  assertEquals(gift.costUsd, 1.05);
});

Deno.test("an anniversary trigger reads ONLY tenure, never XP", () => {
  const ctx = {
    xpTotal: 0,
    badgeKeys: new Set<string>(),
    seasonGoalKeys: new Set<string>(),
    anniversaryYear: 1,
  };
  assertEquals(isMilestoneUnlocked(anniversaryMilestone(), ctx), true);
  assertEquals(
    isMilestoneUnlocked(anniversaryMilestone(), { ...ctx, anniversaryYear: 0 }),
    false,
  );
  // And an XP rung is unaffected by the anniversary being due.
  assertEquals(isMilestoneUnlocked(xpMilestone(), ctx), false);
});

// ─── Config ─────────────────────────────────────────────────────────────────

Deno.test("normalizeLoyaltyConfig clamps and never throws", () => {
  assertEquals(normalizeLoyaltyConfig(null), DEFAULT_LOYALTY_CONFIG);
  assertEquals(normalizeLoyaltyConfig("nonsense"), DEFAULT_LOYALTY_CONFIG);
  const c = normalizeLoyaltyConfig({
    enabled: false,
    anniversary_window_days: 9999,
    comeback_quiet_days: 1,
  });
  assertEquals(c.enabled, false);
  assertEquals(c.anniversaryWindowDays, 90);
  assertEquals(c.comebackQuietDays, 7);
});
