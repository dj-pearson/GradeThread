// Unit tests for the referral reward + leaderboard pure logic (US-864).
//
// referral-rewards.ts is a leaf module (no supabase import), so it imports with
// no env setup.
//
//   deno test src/tests/referral-rewards_test.ts

import { assertEquals } from "@std/assert";
import {
  DEFAULT_REFERRAL_REWARD_CONFIG,
  DEFAULT_REFERRED_SIGNUP_INCENTIVE,
  milestonesReached,
  nextMilestone,
  normalizeReferralRewardConfig,
  normalizeReferredSignupIncentive,
  rankReferrers,
  REFERRAL_MILESTONES,
  REFERRED_REWARD_CREDITS,
  REFERRER_REWARD_CREDITS,
} from "../lib/referral-rewards.ts";

Deno.test("reward sizes are the published values", () => {
  assertEquals(REFERRER_REWARD_CREDITS, 5);
  assertEquals(REFERRED_REWARD_CREDITS, 3);
});

Deno.test("rankReferrers ranks by granted count desc and computes credits", () => {
  const users = [
    { id: "a", display_name: "Alice" },
    { id: "b", display_name: "Bob" },
    { id: "c", display_name: "Cara" },
  ];
  const counts = new Map([["a", 2], ["b", 7], ["c", 4]]);
  const board = rankReferrers(users, counts);
  assertEquals(board.map((r) => r.display_name), ["Bob", "Cara", "Alice"]);
  assertEquals(board[0], {
    display_name: "Bob",
    referrals: 7,
    credits_earned: 7 * REFERRER_REWARD_CREDITS,
  });
});

Deno.test("rankReferrers drops opted-in users with zero granted referrals", () => {
  const users = [
    { id: "a", display_name: "Alice" },
    { id: "z", display_name: "Zero" },
  ];
  const counts = new Map([["a", 1]]); // Zero has no granted referrals
  const board = rankReferrers(users, counts);
  assertEquals(board.length, 1);
  assertEquals(board[0]!.display_name, "Alice");
});

Deno.test("rankReferrers caps the board at the limit", () => {
  const users = Array.from({ length: 150 }, (_, i) => ({
    id: `u${i}`,
    display_name: `User ${i}`,
  }));
  const counts = new Map(users.map((u, i) => [u.id, i + 1]));
  const board = rankReferrers(users, counts, 100);
  assertEquals(board.length, 100);
  // Highest counts first.
  assertEquals(board[0]!.referrals, 150);
});

Deno.test("rankReferrers on an empty cohort returns an empty board", () => {
  assertEquals(rankReferrers([], new Map()), []);
});

// ── US-1071: milestone tiers ──

Deno.test("REFERRAL_MILESTONES is sorted ascending by threshold", () => {
  for (let i = 1; i < REFERRAL_MILESTONES.length; i++) {
    const prev = REFERRAL_MILESTONES[i - 1]!;
    const cur = REFERRAL_MILESTONES[i]!;
    if (cur.threshold <= prev.threshold) {
      throw new Error("REFERRAL_MILESTONES must be sorted ascending by threshold");
    }
  }
});

Deno.test("milestonesReached returns every tier at or below the count", () => {
  assertEquals(milestonesReached(0), []);
  assertEquals(milestonesReached(4), []);
  assertEquals(milestonesReached(5).map((m) => m.threshold), [5]);
  assertEquals(milestonesReached(10).map((m) => m.threshold), [5, 10]);
  assertEquals(
    milestonesReached(1000).map((m) => m.threshold),
    REFERRAL_MILESTONES.map((m) => m.threshold),
  );
});

Deno.test("nextMilestone returns the next unreached tier, null once maxed out", () => {
  assertEquals(nextMilestone(0)?.threshold, 5);
  assertEquals(nextMilestone(5)?.threshold, 10);
  assertEquals(nextMilestone(9)?.threshold, 10);
  const last = REFERRAL_MILESTONES[REFERRAL_MILESTONES.length - 1]!;
  assertEquals(nextMilestone(last.threshold), null);
});

// ── US-1070: referred-user signup incentive config ──

Deno.test("normalizeReferredSignupIncentive on absent/empty config returns the default", () => {
  assertEquals(normalizeReferredSignupIncentive(undefined), DEFAULT_REFERRED_SIGNUP_INCENTIVE);
  assertEquals(normalizeReferredSignupIncentive(null), DEFAULT_REFERRED_SIGNUP_INCENTIVE);
  assertEquals(normalizeReferredSignupIncentive({}), DEFAULT_REFERRED_SIGNUP_INCENTIVE);
  // A non-object (e.g. a stray string/number) is treated as empty.
  assertEquals(normalizeReferredSignupIncentive("nope"), DEFAULT_REFERRED_SIGNUP_INCENTIVE);
});

Deno.test("normalizeReferredSignupIncentive reads a full admin config verbatim", () => {
  assertEquals(
    normalizeReferredSignupIncentive({
      enabled: true,
      bonus_credits: 10,
      free_month_coupon_id: "FREEMONTH",
    }),
    { enabled: true, bonus_credits: 10, free_month_coupon_id: "FREEMONTH" },
  );
});

Deno.test("normalizeReferredSignupIncentive clamps bad credit values to 0", () => {
  assertEquals(normalizeReferredSignupIncentive({ bonus_credits: -5 }).bonus_credits, 0);
  assertEquals(normalizeReferredSignupIncentive({ bonus_credits: NaN }).bonus_credits, 0);
  assertEquals(normalizeReferredSignupIncentive({ bonus_credits: "8" }).bonus_credits, 0);
  // Fractional credits floor to whole credits.
  assertEquals(normalizeReferredSignupIncentive({ bonus_credits: 4.9 }).bonus_credits, 4);
});

Deno.test("normalizeReferredSignupIncentive normalizes blank/whitespace coupon to null", () => {
  assertEquals(normalizeReferredSignupIncentive({ free_month_coupon_id: "" }).free_month_coupon_id, null);
  assertEquals(normalizeReferredSignupIncentive({ free_month_coupon_id: "   " }).free_month_coupon_id, null);
  assertEquals(normalizeReferredSignupIncentive({ free_month_coupon_id: 123 }).free_month_coupon_id, null);
  assertEquals(
    normalizeReferredSignupIncentive({ free_month_coupon_id: "  ABC  " }).free_month_coupon_id,
    "ABC",
  );
});

Deno.test("normalizeReferredSignupIncentive honors an explicit disable", () => {
  const cfg = normalizeReferredSignupIncentive({
    enabled: false,
    bonus_credits: 5,
    free_month_coupon_id: "X",
  });
  assertEquals(cfg.enabled, false);
});

// ── US-1069: admin-configurable referral reward economics ──

Deno.test("DEFAULT_REFERRAL_REWARD_CONFIG preserves the historical 5/3 split, no window/cap", () => {
  assertEquals(DEFAULT_REFERRAL_REWARD_CONFIG, {
    referrer_credits: REFERRER_REWARD_CREDITS,
    referred_credits: REFERRED_REWARD_CREDITS,
    qualification_window_days: 0,
    per_referrer_cap: 0,
  });
});

Deno.test("normalizeReferralRewardConfig on absent/empty config returns the default", () => {
  assertEquals(normalizeReferralRewardConfig(undefined), DEFAULT_REFERRAL_REWARD_CONFIG);
  assertEquals(normalizeReferralRewardConfig(null), DEFAULT_REFERRAL_REWARD_CONFIG);
  assertEquals(normalizeReferralRewardConfig({}), DEFAULT_REFERRAL_REWARD_CONFIG);
  assertEquals(normalizeReferralRewardConfig("nope"), DEFAULT_REFERRAL_REWARD_CONFIG);
});

Deno.test("normalizeReferralRewardConfig reads a full admin config verbatim", () => {
  assertEquals(
    normalizeReferralRewardConfig({
      referrer_credits: 10,
      referred_credits: 6,
      qualification_window_days: 30,
      per_referrer_cap: 25,
    }),
    {
      referrer_credits: 10,
      referred_credits: 6,
      qualification_window_days: 30,
      per_referrer_cap: 25,
    },
  );
});

Deno.test("normalizeReferralRewardConfig clamps negatives/fractions and zeroes bad types", () => {
  const cfg = normalizeReferralRewardConfig({
    referrer_credits: -5,
    referred_credits: 4.9,
    qualification_window_days: "14", // wrong type → 0
    per_referrer_cap: NaN, // → 0
  });
  assertEquals(cfg.referrer_credits, 0);
  assertEquals(cfg.referred_credits, 4);
  assertEquals(cfg.qualification_window_days, 0);
  assertEquals(cfg.per_referrer_cap, 0);
});

Deno.test("normalizeReferralRewardConfig falls back per-field on a partial config", () => {
  // Only referrer_credits supplied — the rest fall back to defaults (not 0).
  assertEquals(normalizeReferralRewardConfig({ referrer_credits: 8 }), {
    referrer_credits: 8,
    referred_credits: REFERRED_REWARD_CREDITS,
    qualification_window_days: 0,
    per_referrer_cap: 0,
  });
});

// US-1784: rankReferrers threads a verified handle only when supplied.
Deno.test("rankReferrers carries verified_handle through for verified sellers", () => {
  const counts = new Map([["a", 5], ["b", 3]]);
  const rows = rankReferrers(
    [
      { id: "a", display_name: "Alice", verified_handle: "alice-vintage" },
      { id: "b", display_name: "Bob" }, // not verified → no handle
    ],
    counts,
  );
  assertEquals(rows[0].display_name, "Alice");
  assertEquals(rows[0].verified_handle, "alice-vintage");
  assertEquals(rows[1].verified_handle, undefined);
});
