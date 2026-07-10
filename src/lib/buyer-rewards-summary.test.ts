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
});
