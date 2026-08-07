// US-1814: buyer rewards surface math — confirmation streak + lifetime impact.
//
// US-1851 made this the ONLY streak in the product. Seller surfaces moved to
// quarterly seasons, because reselling is bursty and a calendar streak turns a
// normal slow sourcing month into a status loss. The buyer confirmation flow is
// different: a buyer receives parcels on a genuinely weekly rhythm, "did it match
// its grade?" is a 30-second act, and the streak is what pulls the ground-truth
// data in. So the streak stays here — with grace and freeze rules, so one quiet
// week from a real person doesn't erase months of honest confirmations.
//
// Pure, unit-tested. Reuses the North Star weekly-streak model (Monday-anchored
// local weeks). Fed by the buyer's own grade_outcomes rows (RLS owner-read); no
// network here.

import { startOfWeek, weekKey } from "./north-star";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ── Grace / freeze policy (US-1851 AC3) ──────────────────────────────────────
//
// GRACE: the CURRENT week never breaks a streak just by being young. A chain
// that ran through last week is alive all of this week — you have until Sunday.
//
// FREEZE: a chain banks one freeze for every 4 active weeks it contains, up to 2.
// A missed week SPENDS a freeze and the chain continues across it (the frozen
// week itself is not counted as active — you get to keep the streak, not to
// claim a week you skipped). Two banked freezes means a fortnight away doesn't
// cost you the chain; a brand-new buyer has none, so freezes can't be farmed by
// confirming once and vanishing.
export const FREEZE_EARNED_EVERY_WEEKS = 4;
export const MAX_BANKED_FREEZES = 2;

// Hard bound on the backwards walk — a decade of weeks. A malformed key can
// never spin this forever.
const MAX_WALK_WEEKS = 520;

export interface BuyerRewardsSummary {
  /** All-time confirmations (arrivals the buyer said matched the grade). */
  lifetimeConfirmations: number;
  /** Over-graded listings the buyer caught (disputes filed). */
  caughtOverGraded: number;
  /** Consecutive weeks (through this week or last) with ≥1 confirmation. */
  currentStreakWeeks: number;
  /** The buyer's best-ever confirmation streak. */
  longestStreakWeeks: number;
  /** Freezes the CURRENT chain has spent to bridge missed weeks. */
  freezesUsed: number;
  /** Freezes the current chain still has in hand. */
  freezesBanked: number;
  /** True when this week has no confirmation yet but the chain is still alive. */
  inGraceWeek: boolean;
}

interface Run {
  /** Active weeks in the chain (frozen weeks are NOT counted). */
  weeks: number;
  /** Missed weeks the chain bridged with a freeze. */
  gapsUsed: number;
}

/** How many freezes a chain of `activeWeeks` has earned, capped. */
function freezesEarned(activeWeeks: number): number {
  return Math.min(MAX_BANKED_FREEZES, Math.floor(activeWeeks / FREEZE_EARNED_EVERY_WEEKS));
}

/**
 * Walk backwards from `anchor`, bridging at most `bridgeLimit` missed weeks.
 * Stops at the first gap it is not allowed to bridge.
 */
function walkRun(
  active: Set<string>,
  anchor: string,
  prevWeekKey: (k: string) => string,
  bridgeLimit: number,
): Run {
  let weeks = 0;
  let gapsUsed = 0;
  let cursor = anchor;
  for (let step = 0; step < MAX_WALK_WEEKS; step++) {
    if (active.has(cursor)) {
      weeks++;
    } else {
      if (gapsUsed >= bridgeLimit) break;
      gapsUsed++;
    }
    cursor = prevWeekKey(cursor);
  }
  return { weeks, gapsUsed };
}

/**
 * The longest chain ending at `anchor`, honouring the freeze allowance.
 *
 * Freezes are earned by the chain they bridge, so the allowance and the chain
 * are mutually dependent — bridging one more gap can reveal enough active weeks
 * to have paid for it. Resolved by trying each bridge budget from 0 up and
 * keeping the largest chain whose own active weeks actually cover the gaps it
 * used. At most three passes (the cap is 2 freezes).
 */
function bestRunEndingAt(
  active: Set<string>,
  anchor: string,
  prevWeekKey: (k: string) => string,
): Run {
  let best = walkRun(active, anchor, prevWeekKey, 0);
  for (let k = 1; k <= MAX_BANKED_FREEZES; k++) {
    const cand = walkRun(active, anchor, prevWeekKey, k);
    if (cand.weeks <= best.weeks) break; // no more chain to win — stop spending
    if (freezesEarned(cand.weeks) < cand.gapsUsed) break; // chain can't pay for it
    best = cand;
  }
  return best;
}

/**
 * Compute the rewards surface from the buyer's confirmation dates + a dispute
 * count. `confirmedAt` is one ISO timestamp per confirmed outcome; the streak is
 * the run of consecutive weeks (ending this week or last, so a not-yet-active
 * current week doesn't reset it) that contain at least one confirmation, with
 * missed weeks bridged by banked freezes. Pure — `nowMs` injected for
 * deterministic tests.
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
  const thisWeekKey = weekKey(new Date(currentWeekStart));

  // Current streak: anchor at this week; if it has no confirmation yet, the chain
  // may still be alive through last week (the grace week), so step back once.
  const inGraceWeek = !weeks.has(thisWeekKey);
  const anchor = inGraceWeek ? prevWeekKey(thisWeekKey) : thisWeekKey;
  const current = bestRunEndingAt(weeks, anchor, prevWeekKey);

  // Longest streak: the best chain ending at each active week.
  let longestStreakWeeks = 0;
  for (const key of weeks) {
    const run = bestRunEndingAt(weeks, key, prevWeekKey);
    if (run.weeks > longestStreakWeeks) longestStreakWeeks = run.weeks;
  }

  return {
    lifetimeConfirmations: confirmedAt.length,
    caughtOverGraded: Math.max(0, disputedCount),
    currentStreakWeeks: current.weeks,
    longestStreakWeeks: Math.max(longestStreakWeeks, current.weeks),
    freezesUsed: current.gapsUsed,
    freezesBanked: Math.max(0, freezesEarned(current.weeks) - current.gapsUsed),
    // Only a LIVE chain is in its grace week; with no streak there is nothing to
    // save, and telling a buyer with zero confirmations that their week is
    // "still open" would be noise.
    inGraceWeek: inGraceWeek && current.weeks > 0,
  };
}
