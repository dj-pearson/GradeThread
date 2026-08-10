// US-1915 AC3: the admin rewards-analytics report.
//
// Pure assembly over already-loaded rows. The four metric DEFINITIONS live in
// rewards-north-star.ts and are not re-derived here — this module only decides
// what gets compared with what, which is where the mistakes actually live.

import {
  type CohortMember,
  costPerRetainedUser,
  type GrantCost,
  gradesPerActiveUser,
  type KFactorInputs,
  shareKFactor,
  weekFourRetention,
} from "./rewards-north-star.ts";

/** A cohort member plus whether they ever engaged with a reward mechanic. */
export interface ClassifiedCohortMember extends CohortMember {
  /**
   * True when the user has at least one reward event.
   *
   * ⚠ THIS IS OBSERVED, NOT ASSIGNED. See `RETENTION_COMPARISON_CAVEAT`.
   */
  gamified: boolean;
}

/**
 * ⚠ THE SENTENCE THIS WHOLE MODULE EXISTS TO CARRY.
 *
 * Splitting the cohort by "did they engage with rewards" is a SELF-SELECTED
 * comparison, not an experiment. Nobody was randomised into the gamified arm —
 * users who engage with rewards are already the more engaged users, so they
 * would retain better with no gamification at all. The gap is therefore an
 * UPPER BOUND on the effect and mostly measures who opts in.
 *
 * It is shipped anyway because "do engaged users retain" is still worth seeing,
 * and because the alternative — no view at all — is what let the epic scale
 * unmeasured. But it travels WITH this caveat, in the payload rather than only
 * in a comment, so the surface rendering it cannot quietly present it as causal.
 *
 * The only randomised control in the system is `reward_nudge_sends.holdout`
 * (US-1859). Draw causal conclusions from that, not from this.
 */
export const RETENTION_COMPARISON_CAVEAT =
  "Self-selected, not randomised: users who engage with rewards were already " +
  "more engaged, so this gap is an upper bound and mostly measures who opts " +
  "in. For a causal read use the reward_nudge_sends holdout (US-1859).";

export interface NorthStarInputs {
  cohort: readonly ClassifiedCohortMember[];
  grades: number;
  gradingUsers: number;
  /**
   * ⚠ NULL WHEN THE SHARE HALF IS NOT KNOWABLE HERE, which is the normal case
   * for a server-side caller.
   *
   * K needs SHARES and SHARERS. A share is a client action — the user taps the
   * sheet or copies a link — and nothing reaches a server when it happens; the
   * database only learns about the CLICK afterwards, via badge-analytics. So a
   * DB-only caller can see conversions and cannot see shares.
   *
   * Passing `{sharers: 0, shares: 0, conversions: n}` to fake it would be worse
   * than useless: `sharers: 0` asserts that nobody shared, which is false, and
   * it would sit beside a non-zero conversion count that contradicts it. Null
   * means "not measured here" and the report says so in its own payload.
   */
  kFactor: KFactorInputs | null;
  grants: readonly GrantCost[];
  nowMs: number;
}

/** Why K is absent, when it is. Shipped so a UI cannot render a blank as zero. */
export const K_FACTOR_UNAVAILABLE_REASON =
  "Not computable from the database: a share is a client action that never " +
  "reaches a server, so shares and sharers live in PostHog " +
  "(reward_card_share). The database sees only the resulting clicks.";

export interface RetentionComparison {
  gamified: ReturnType<typeof weekFourRetention>;
  notGamified: ReturnType<typeof weekFourRetention>;
  /**
   * Percentage-point gap, or null when either arm has no eligible members.
   *
   * Null rather than 0 for the same reason every ratio in rewards-north-star.ts
   * is null on an empty denominator: "no gap" and "nothing to compare" are
   * opposite claims, and a 0 on a dashboard reads as the former.
   */
  gapPp: number | null;
  /** Always present. Not optional, so it cannot be dropped by omission. */
  caveat: string;
  /** Machine-readable form of the same fact, for a UI that wants to gate on it. */
  causal: false;
}

/** K, or an explicit statement that it was not measured. Never a silent blank. */
export type KFactorSlot =
  | ({ available: true } & ReturnType<typeof shareKFactor>)
  | { available: false; reason: string };

export interface NorthStarReport {
  retention: ReturnType<typeof weekFourRetention>;
  retentionComparison: RetentionComparison;
  gradesPerUser: ReturnType<typeof gradesPerActiveUser>;
  kFactor: KFactorSlot;
  costPerRetained: ReturnType<typeof costPerRetainedUser>;
}

/** Percentage-point difference between two rates, or null if either is null. */
function gapInPoints(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.round((a - b) * 1000) / 10;
}

/**
 * Assemble the report.
 *
 * The overall retention figure and the two arms are computed by the SAME
 * function over the same window — the split is only a filter on the input, so
 * the arms can never drift from the headline by using different arithmetic.
 */
export function rewardsNorthStarReport(input: NorthStarInputs): NorthStarReport {
  const overall = weekFourRetention(input.cohort, input.nowMs);
  const gamified = weekFourRetention(
    input.cohort.filter((m) => m.gamified),
    input.nowMs,
  );
  const notGamified = weekFourRetention(
    input.cohort.filter((m) => !m.gamified),
    input.nowMs,
  );

  return {
    retention: overall,
    retentionComparison: {
      gamified,
      notGamified,
      gapPp: gapInPoints(gamified.rate, notGamified.rate),
      caveat: RETENTION_COMPARISON_CAVEAT,
      causal: false,
    },
    gradesPerUser: gradesPerActiveUser(input.grades, input.gradingUsers),
    kFactor: input.kFactor === null
      ? { available: false, reason: K_FACTOR_UNAVAILABLE_REASON }
      : { available: true, ...shareKFactor(input.kFactor) },
    // Divided by the HEADLINE retained count, not by the gamified arm: a
    // tangible grant can land on anyone, so charging it to a subset would
    // overstate cost per retained user by whatever the split happens to be.
    costPerRetained: costPerRetainedUser(input.grants, overall.retained),
  };
}
