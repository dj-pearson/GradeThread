// US-1851 AC3: the buyer confirmation streak, with explicit grace and freezes.
//
// This is the ONLY streak GradeThread shows a human, and that is a deliberate
// narrowing. A calendar streak is only fair where the action is genuinely
// recurring, and confirming an arrival is: a buyer who is buying is receiving
// parcels weekly. Seller surfaces show SEASON progress instead
// (services/edge-functions/src/lib/rewards-seasons.ts) because sourcing is
// bursty and a streak would punish the ordinary gap between trips.
//
// Two protections, and the difference between them matters:
//
//   GRACE is free and automatic — the week you are IN cannot break the chain,
//   because it has not finished yet. Without it a buyer opening the app on a
//   Monday morning would be told their streak had ended, which is a lie about
//   a week that has barely started.
//
//   A FREEZE is spent, and covers a week that genuinely passed with nothing in
//   it. Each buyer gets a small, fixed allowance per calendar quarter, granted
//   automatically — there is nothing to buy, remember, or activate, so the
//   protection reaches the buyer who was on holiday rather than the buyer who
//   read the help page. The allowance is per quarter so it refills on the same
//   clock the seller seasons use, and a long absence still ends the streak: two
//   freezes cannot paper over a lost month.
//
// Pure and clock-injected — the whole thing unit-tests without a network.

import { startOfWeek, weekKey } from "./north-star";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Freezes granted per calendar quarter, spent automatically on missed weeks. */
export const STREAK_FREEZES_PER_QUARTER = 2;

export interface StreakState {
  /** Consecutive protected weeks ending at this week or last. */
  current: number;
  /** Best run ever, computed with the same freeze rules. */
  longest: number;
  /** Freezes spent inside the CURRENT streak. */
  freezesUsed: number;
  /** Freezes left in this quarter's allowance. */
  freezesRemaining: number;
  /**
   * True when this week has no confirmation yet AND no freeze is left to cover
   * it — i.e. the chain really does end if the week closes empty. Grace alone
   * never makes a streak "at risk", or the warning would fire every Monday and
   * mean nothing.
   */
  atRisk: boolean;
}

/** The Monday-key of the week before the one `key` names. */
function prevWeekKey(key: string): string {
  const monday = new Date(`${key}T00:00:00`);
  // Re-normalize through weekKey: a fixed WEEK_MS step can land ±1h off a
  // Monday across a DST change.
  return weekKey(new Date(monday.getTime() - WEEK_MS));
}

/** The calendar quarter (0–3) a week's Monday falls in. */
function quarterOfWeek(key: string): string {
  const monday = new Date(`${key}T00:00:00`);
  return `${monday.getFullYear()}-Q${Math.floor(monday.getMonth() / 3) + 1}`;
}

/**
 * Walk back from `fromKey` counting protected weeks. A missed week is absorbed
 * by a freeze while that week's own quarter still has allowance left; the walk
 * stops at the first miss it cannot cover.
 *
 * Freezes are budgeted per quarter of the MISSED week, not of "now", so a run
 * spanning three quarters gets each quarter's allowance for the gaps that
 * actually fell in it — and a single quarter can never be over-drawn.
 */
function walkBack(
  weeks: Set<string>,
  fromKey: string,
): { length: number; freezesUsed: number; spentByQuarter: Map<string, number> } {
  const spentByQuarter = new Map<string, number>();
  let length = 0;
  let freezesUsed = 0;
  let cursor = fromKey;

  while (true) {
    if (weeks.has(cursor)) {
      length++;
      cursor = prevWeekKey(cursor);
      continue;
    }
    // A miss. Cover it with a freeze if this quarter still has one AND the
    // chain actually continues past it — spending a freeze on a gap with
    // nothing behind it would inflate the streak with empty weeks.
    const q = quarterOfWeek(cursor);
    const spent = spentByQuarter.get(q) ?? 0;
    if (spent >= STREAK_FREEZES_PER_QUARTER) break;
    const before = prevWeekKey(cursor);
    if (!weeks.has(before)) break;
    spentByQuarter.set(q, spent + 1);
    freezesUsed++;
    cursor = before;
  }

  return { length, freezesUsed, spentByQuarter };
}

/**
 * The buyer's confirmation streak. `confirmedAt` is one ISO timestamp per
 * confirmed outcome; weeks are Monday-anchored in the buyer's own local zone,
 * which is the zone they experience "this week" in.
 */
export function computeConfirmationStreak(confirmedAt: string[], nowMs: number): StreakState {
  const weeks = new Set<string>();
  for (const iso of confirmedAt) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) weeks.add(weekKey(new Date(t)));
  }

  const thisWeek = weekKey(startOfWeek(new Date(nowMs)));
  const thisWeekActive = weeks.has(thisWeek);

  // GRACE: an empty current week is not a miss, so start the walk at last week
  // when this one has nothing in it yet.
  const start = thisWeekActive ? thisWeek : prevWeekKey(thisWeek);
  const run = weeks.size === 0 ? { length: 0, freezesUsed: 0, spentByQuarter: new Map() } : walkBack(weeks, start);

  const currentQuarter = quarterOfWeek(thisWeek);
  const freezesRemaining = Math.max(
    0,
    STREAK_FREEZES_PER_QUARTER - (run.spentByQuarter.get(currentQuarter) ?? 0),
  );

  // Longest: the best run ending at any active week, same rules.
  let longest = 0;
  for (const key of weeks) {
    const len = walkBack(weeks, key).length;
    if (len > longest) longest = len;
  }

  return {
    current: run.length,
    longest: Math.max(longest, run.length),
    freezesUsed: run.freezesUsed,
    freezesRemaining,
    atRisk: run.length > 0 && !thisWeekActive && freezesRemaining === 0,
  };
}
