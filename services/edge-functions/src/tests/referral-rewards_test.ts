// Unit tests for the referral reward + leaderboard pure logic (US-864).
//
// referral-rewards.ts is a leaf module (no supabase import), so it imports with
// no env setup.
//
//   deno test src/tests/referral-rewards_test.ts

import { assertEquals } from "@std/assert";
import {
  milestonesReached,
  nextMilestone,
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
