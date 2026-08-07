// US-1814: buyer rewards surface math — confirmation streak + lifetime impact.
//
// Pure, unit-tested. Monday-anchored local weeks, matching the North Star
// listing week. Fed by the buyer's own grade_outcomes rows (RLS owner-read); no
// network here.
//
// US-1851 moved the streak walk itself into buyer-streak.ts, which added the
// explicit grace/freeze rules. This module keeps the lifetime-impact numbers
// and re-exposes the streak so existing callers do not have to change shape.

import { computeConfirmationStreak, type StreakState } from "./buyer-streak";

export interface BuyerRewardsSummary {
  /** All-time confirmations (arrivals the buyer said matched the grade). */
  lifetimeConfirmations: number;
  /** Over-graded listings the buyer caught (disputes filed). */
  caughtOverGraded: number;
  /** Consecutive weeks (through this week or last) with ≥1 confirmation. */
  currentStreakWeeks: number;
  /** The buyer's best-ever confirmation streak. */
  longestStreakWeeks: number;
  /** US-1851: grace/freeze detail behind the streak number. */
  streak: StreakState;
}

/**
 * Compute the rewards surface from the buyer's confirmation dates + a dispute
 * count. `confirmedAt` is one ISO timestamp per confirmed outcome. Pure —
 * `nowMs` injected for deterministic tests.
 */
export function computeBuyerRewardsSummary(
  confirmedAt: string[],
  disputedCount: number,
  nowMs: number,
): BuyerRewardsSummary {
  const streak = computeConfirmationStreak(confirmedAt, nowMs);
  return {
    lifetimeConfirmations: confirmedAt.length,
    caughtOverGraded: Math.max(0, disputedCount),
    currentStreakWeeks: streak.current,
    longestStreakWeeks: streak.longest,
    streak,
  };
}
