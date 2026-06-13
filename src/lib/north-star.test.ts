import { describe, it, expect } from "vitest";
import { computeNorthStar, startOfWeek, weekKey } from "@/lib/north-star";

// Fixed reference "now": Wednesday, 2026-06-10 (a midweek day).
const NOW = new Date(2026, 5, 10, 12, 0, 0);

// Helper: an ISO date N days before NOW.
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("startOfWeek / weekKey", () => {
  it("anchors weeks to Monday", () => {
    // 2026-06-10 is a Wednesday → Monday is 2026-06-08.
    expect(weekKey(NOW)).toBe("2026-06-08");
    expect(startOfWeek(NOW).getDay()).toBe(1); // Monday
  });

  it("treats Sunday as the end of the prior Monday-week", () => {
    const sunday = new Date(2026, 5, 14, 23, 0, 0); // 2026-06-14 is a Sunday
    expect(weekKey(sunday)).toBe("2026-06-08");
  });
});

describe("computeNorthStar", () => {
  it("counts items listed in the current week and reports goal progress", () => {
    const stats = computeNorthStar(
      [daysAgo(0), daysAgo(1), daysAgo(2), daysAgo(30), null],
      { goal: 10, now: NOW },
    );
    expect(stats.listedThisWeek).toBe(3); // 0,1,2 days ago are this week
    expect(stats.lifetimeListed).toBe(4); // null excluded
    expect(stats.goal).toBe(10);
    expect(stats.goalMet).toBe(false);
    expect(stats.progress).toBeCloseTo(0.3, 5);
  });

  it("marks the goal met and clamps progress at 1", () => {
    const dates = Array.from({ length: 12 }, () => daysAgo(0));
    const stats = computeNorthStar(dates, { goal: 10, now: NOW });
    expect(stats.goalMet).toBe(true);
    expect(stats.progress).toBe(1);
  });

  it("builds a multi-week streak from consecutive weeks", () => {
    // One listing in each of the last 3 weeks (this week + 2 prior).
    const stats = computeNorthStar([daysAgo(1), daysAgo(8), daysAgo(15)], {
      goal: 10,
      now: NOW,
    });
    expect(stats.streakWeeks).toBe(3);
  });

  it("does not break the streak when the current week is empty (week in progress)", () => {
    // Nothing this week, but the two prior weeks had listings.
    const stats = computeNorthStar([daysAgo(8), daysAgo(15)], {
      goal: 10,
      now: NOW,
    });
    expect(stats.listedThisWeek).toBe(0);
    expect(stats.streakWeeks).toBe(2);
  });

  it("breaks the streak across a gap week", () => {
    // This week + a week ~3 weeks ago, with a gap in between.
    const stats = computeNorthStar([daysAgo(1), daysAgo(22)], {
      goal: 10,
      now: NOW,
    });
    expect(stats.streakWeeks).toBe(1);
  });

  it("computes the next lifetime milestone", () => {
    const stats = computeNorthStar(
      Array.from({ length: 12 }, (_, i) => daysAgo(i)),
      { goal: 10, now: NOW },
    );
    expect(stats.lifetimeListed).toBe(12);
    expect(stats.nextMilestone).toBe(25);
    expect(stats.toNextMilestone).toBe(13);
  });

  it("returns a zeroed surface with no listings", () => {
    const stats = computeNorthStar([null, undefined], { goal: 10, now: NOW });
    expect(stats.listedThisWeek).toBe(0);
    expect(stats.streakWeeks).toBe(0);
    expect(stats.lifetimeListed).toBe(0);
    expect(stats.nextMilestone).toBe(10);
  });
});
