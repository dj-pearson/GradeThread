// US-1814: buyer rewards surface math — confirmation streak + lifetime impact.
//
// Pure, unit-tested. Reuses the North Star weekly-streak model (Monday-anchored
// local weeks, "don't break the chain") so the buyer's confirmation streak reads
// the same way the seller's listing streak does. Fed by the buyer's own
// grade_outcomes rows (RLS owner-read); no network here.

import { startOfWeek, weekKey } from "./north-star";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface BuyerRewardsSummary {
  /** All-time confirmations (arrivals the buyer said matched the grade). */
  lifetimeConfirmations: number;
  /** Over-graded listings the buyer caught (disputes filed). */
  caughtOverGraded: number;
  /** Consecutive weeks (through this week or last) with ≥1 confirmation. */
  currentStreakWeeks: number;
  /** The buyer's best-ever confirmation streak. */
  longestStreakWeeks: number;
}

/**
 * Compute the rewards surface from the buyer's confirmation dates + a dispute
 * count. `confirmedAt` is one ISO timestamp per confirmed outcome; the streak is
 * the run of consecutive weeks (ending this week or last, so a not-yet-active
 * current week doesn't reset it) that contain at least one confirmation. Pure —
 * `nowMs` injected for deterministic tests.
 */
export function computeBuyerRewardsSummary(
  confirmedAt: string[],
  disputedCount: number,
  nowMs: number,
): BuyerRewardsSummary {
  const weeks = new Set<string>();
  for (const iso of confirmedAt) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) weeks.add(weekKey(new Date(t)));
  }

  // The Monday-key of the week before the one `key` names. Re-normalizes through
  // weekKey so it's DST-safe (a fixed WEEK_MS step can land ±1h off a Monday).
  const prevWeekKey = (key: string): string => {
    const monday = new Date(`${key}T00:00:00`);
    return weekKey(new Date(monday.getTime() - WEEK_MS));
  };

  const currentWeekStart = startOfWeek(new Date(nowMs)).getTime();

  // Current streak: start at this week; if it has no confirmation yet, the chain
  // may still be alive through last week, so step back once before walking.
  let currentStreakWeeks = 0;
  let cursorKey = weekKey(new Date(currentWeekStart));
  if (!weeks.has(cursorKey)) cursorKey = prevWeekKey(cursorKey);
  while (weeks.has(cursorKey)) {
    currentStreakWeeks++;
    cursorKey = prevWeekKey(cursorKey);
  }

  // Longest streak: for each active week, count the consecutive run ending there.
  let longestStreakWeeks = 0;
  for (const key of weeks) {
    let len = 0;
    let k: string = key;
    while (weeks.has(k)) {
      len++;
      k = prevWeekKey(k);
    }
    if (len > longestStreakWeeks) longestStreakWeeks = len;
  }

  return {
    lifetimeConfirmations: confirmedAt.length,
    caughtOverGraded: Math.max(0, disputedCount),
    currentStreakWeeks,
    longestStreakWeeks: Math.max(longestStreakWeeks, currentStreakWeeks),
  };
}
