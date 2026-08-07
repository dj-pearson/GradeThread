import { describe, it, expect } from "vitest";
import { computeBuyerRewardsSummary } from "@/lib/buyer-rewards-summary";

// Fixed reference "now": Wednesday, 2026-06-10 (a midweek day → this week is
// active from Monday 2026-06-08).
const NOW = new Date(2026, 5, 10, 12, 0, 0).getTime();
const WEEK = 7 * 24 * 60 * 60 * 1000;

function weeksAgo(n: number): string {
  return new Date(NOW - n * WEEK).toISOString();
}

describe("computeBuyerRewardsSummary", () => {
  it("counts lifetime confirmations and caught over-grades", () => {
    const s = computeBuyerRewardsSummary([weeksAgo(0), weeksAgo(1), weeksAgo(1)], 4, NOW);
    expect(s.lifetimeConfirmations).toBe(3);
    expect(s.caughtOverGraded).toBe(4);
  });

  it("empty history → zeros", () => {
    const s = computeBuyerRewardsSummary([], 0, NOW);
    expect(s).toEqual({
      lifetimeConfirmations: 0,
      caughtOverGraded: 0,
      currentStreakWeeks: 0,
      longestStreakWeeks: 0,
      freezesUsed: 0,
      freezesBanked: 0,
      // Nothing to save → not "in grace", which would be noise.
      inGraceWeek: false,
    });
  });

  it("a confirmation this week and each of the prior two weeks → streak 3", () => {
    const s = computeBuyerRewardsSummary([weeksAgo(0), weeksAgo(1), weeksAgo(2)], 0, NOW);
    expect(s.currentStreakWeeks).toBe(3);
    expect(s.longestStreakWeeks).toBe(3);
  });

  it("no confirmation THIS week keeps the streak alive through last week", () => {
    const s = computeBuyerRewardsSummary([weeksAgo(1), weeksAgo(2)], 0, NOW);
    expect(s.currentStreakWeeks).toBe(2);
  });

  it("a gap breaks the current streak but the longest run survives", () => {
    // weeks: this, -1, then a gap, then -4, -5, -6 (a run of 3).
    const s = computeBuyerRewardsSummary(
      [weeksAgo(0), weeksAgo(1), weeksAgo(4), weeksAgo(5), weeksAgo(6)],
      0,
      NOW,
    );
    expect(s.currentStreakWeeks).toBe(2);
    expect(s.longestStreakWeeks).toBe(3);
  });

  it("multiple confirmations in one week count that week once for the streak", () => {
    const s = computeBuyerRewardsSummary([weeksAgo(0), weeksAgo(0), weeksAgo(0)], 0, NOW);
    expect(s.currentStreakWeeks).toBe(1);
    expect(s.lifetimeConfirmations).toBe(3);
  });

  it("a stale streak (all confirmations >2 weeks ago) is 0 now", () => {
    const s = computeBuyerRewardsSummary([weeksAgo(3), weeksAgo(4)], 0, NOW);
    expect(s.currentStreakWeeks).toBe(0);
    expect(s.longestStreakWeeks).toBe(2);
  });

  it("ignores unparseable timestamps", () => {
    const s = computeBuyerRewardsSummary(["not-a-date", weeksAgo(0)], 0, NOW);
    expect(s.lifetimeConfirmations).toBe(2); // count is raw length…
    expect(s.currentStreakWeeks).toBe(1); // …but only the valid date drives the streak
  });

  // ── US-1851: grace + streak freeze ───────────────────────────────────────

  it("a live chain with no confirmation yet this week is in its grace week", () => {
    const s = computeBuyerRewardsSummary([weeksAgo(1), weeksAgo(2)], 0, NOW);
    expect(s.inGraceWeek).toBe(true);
    expect(s.currentStreakWeeks).toBe(2);
  });

  it("this week already confirmed → not in grace", () => {
    const s = computeBuyerRewardsSummary([weeksAgo(0), weeksAgo(1)], 0, NOW);
    expect(s.inGraceWeek).toBe(false);
  });

  it("a long chain banks freezes and bridges a missed week", () => {
    // Active weeks 1–8 (eight of them), nothing this week. The chain has earned
    // two freezes, so the missed week at -9 does not end it… except there is no
    // week -9 activity to bridge TO, so this asserts the earn side.
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map(weeksAgo);
    const s = computeBuyerRewardsSummary(eight, 0, NOW);
    expect(s.currentStreakWeeks).toBe(8);
    expect(s.freezesUsed).toBe(0);
    expect(s.freezesBanked).toBe(2);
  });

  it("one missed week inside a long chain is frozen, not broken", () => {
    // Weeks 0–3 and 5–8 active; week 4 missed. Nine calendar weeks, eight active.
    const active = [0, 1, 2, 3, 5, 6, 7, 8].map(weeksAgo);
    const s = computeBuyerRewardsSummary(active, 0, NOW);
    expect(s.currentStreakWeeks).toBe(8);
    expect(s.freezesUsed).toBe(1);
    expect(s.freezesBanked).toBe(1);
  });

  it("a short chain has earned no freeze, so one gap ends it", () => {
    // Weeks 0, 1 and 3 active. Even bridging week 2 the chain holds only three
    // active weeks — under the 4-week earn threshold — so it cannot pay for the
    // freeze and stops at the gap.
    const s = computeBuyerRewardsSummary([0, 1, 3].map(weeksAgo), 0, NOW);
    expect(s.currentStreakWeeks).toBe(2);
    expect(s.freezesUsed).toBe(0);
    expect(s.freezesBanked).toBe(0);
  });

  it("three missed weeks in a row are past the cap — and no freeze is wasted", () => {
    // Weeks 0–7 active, then 8, 9 and 10 all missed. Two freezes can never span
    // three weeks, so the chain ends at the gap and the buyer KEEPS both banked
    // rather than burning them for nothing.
    const active = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12].map(weeksAgo);
    const s = computeBuyerRewardsSummary(active, 0, NOW);
    expect(s.currentStreakWeeks).toBe(8);
    expect(s.freezesUsed).toBe(0);
    expect(s.freezesBanked).toBe(2);
  });
});
