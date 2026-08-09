// US-1915 AC1: the north-star metric definitions, as code.
//
// The story exists because the gamification epic shipped mechanics with no
// agreed way to tell dopamine from retention. Its own note warned that
// retro-instrumenting cohorts is impossible — and the audit in the story notes
// found the substrate had in fact been built (reputation_events is the event
// spine, reward_tangible_grants itemises cost_usd, reward_nudge_sends carries a
// holdout). What was missing is THIS: the arithmetic, named and pinned, so the
// admin surface renders a definition rather than inventing one.
//
// EVERYTHING HERE IS PURE. No supabase import, no DB, no clock of its own —
// `nowMs` is always a parameter. The caller loads rows; this module decides what
// they mean. That is the shape rewards-economics.ts already uses for the same
// reason: a metric you cannot unit-test is a metric nobody can argue with.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE DEFINITIONS ARE THE DELIVERABLE, NOT THE DIVISION.
//
// Every metric below is a ratio, and every ratio is easy. What makes them wrong
// in practice is an unstated denominator, so each one states its own — and the
// two decisions most likely to be got wrong silently are:
//
//   1. **AN IMMATURE COHORT IS EXCLUDED, NOT COUNTED AS CHURNED.** A user who
//      signed up nine days ago has not failed week-4 retention; they have not
//      reached it. Counting them in the denominator is the single most common
//      way a retention number is quietly understated, and it understates worst
//      exactly when growth is fastest — so the metric looks like it is falling
//      while the product improves. `weekFourRetention` refuses undecided users
//      and REPORTS how many it dropped, because a silently smaller denominator
//      is the same bug wearing a different hat.
//   2. **A RATIO OVER AN EMPTY DENOMINATOR IS NULL, NEVER ZERO.** "No retained
//      users yet" and "cost per retained user is $0" are opposite claims, and
//      Infinity or NaN reaching a dashboard renders as neither. Every function
//      here returns `null` for undefined and says so in its type.
//
// Contract: vault/20-domain/reward-ledger.md.

// ─── Week-4 retention by cohort ─────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Week 4 is days 21–27 inclusive, zero-indexed from signup. */
export const WEEK_FOUR_START_DAY = 21;
export const WEEK_FOUR_END_DAY = 28; // exclusive

/** A user's signup instant plus the instants at which they did something. */
export interface CohortMember {
  userId: string;
  /** ISO timestamp of signup. Defines both the cohort and the week windows. */
  signedUpAt: string;
  /** ISO timestamps of qualifying activity. Order irrelevant; duplicates fine. */
  activeAt: readonly string[];
}

export interface RetentionResult {
  /** Users whose week-4 window has fully elapsed — the honest denominator. */
  eligible: number;
  /** Of those, how many were active at least once during days 21–27. */
  retained: number;
  /** retained / eligible, or null when no cohort member has aged in yet. */
  rate: number | null;
  /**
   * Members excluded because their week-4 window has not closed. Surfaced
   * deliberately: a denominator that shrank for a good reason still has to be
   * visible, or the next reader assumes the cohort was small.
   */
  undecided: number;
}

/**
 * Week-4 retention for one cohort.
 *
 * A member counts as RETAINED when they have at least one activity timestamp in
 * `[signup + 21d, signup + 28d)`. A member is UNDECIDED — and excluded from both
 * numerator and denominator — when `nowMs` has not yet reached the end of that
 * window for them.
 *
 * ⚠ Activity before day 21 does not count and is not meant to: this measures
 * whether they came BACK, not whether they arrived.
 */
export function weekFourRetention(
  members: readonly CohortMember[],
  nowMs: number,
): RetentionResult {
  let eligible = 0;
  let retained = 0;
  let undecided = 0;

  for (const m of members) {
    const signup = Date.parse(m.signedUpAt);
    // An unparseable signup cannot be placed in a window at all. Treat it as
    // undecided rather than guessing — it is a data problem, not a churn signal.
    if (!Number.isFinite(signup)) {
      undecided++;
      continue;
    }
    const windowStart = signup + WEEK_FOUR_START_DAY * DAY_MS;
    const windowEnd = signup + WEEK_FOUR_END_DAY * DAY_MS;
    if (nowMs < windowEnd) {
      undecided++;
      continue;
    }
    eligible++;
    const cameBack = m.activeAt.some((ts) => {
      const t = Date.parse(ts);
      return Number.isFinite(t) && t >= windowStart && t < windowEnd;
    });
    if (cameBack) retained++;
  }

  return {
    eligible,
    retained,
    rate: eligible === 0 ? null : retained / eligible,
    undecided,
  };
}

// ─── Grades per user per month ──────────────────────────────────────────────

export interface GradesPerUserResult {
  grades: number;
  /** Users who graded at least once in the window — see the note below. */
  activeUsers: number;
  /** grades / activeUsers, or null when nobody graded. */
  perUser: number | null;
}

/**
 * Grades per ACTIVE user over a window.
 *
 * ⚠ THE DENOMINATOR IS USERS WHO GRADED, NOT USERS WHO EXIST. Dividing by every
 * registered account measures signup growth far more than it measures usage —
 * a marketing push would drive this metric DOWN while nothing about behaviour
 * changed. This answers "how much does someone who uses it, use it", which is
 * the question the gamification epic is actually asking.
 *
 * Takes counts rather than rows because the caller can get both from one grouped
 * query, and passing thousands of rows through here to count them would be waste.
 */
export function gradesPerActiveUser(
  grades: number,
  activeUsers: number,
): GradesPerUserResult {
  const safeGrades = Math.max(0, Math.trunc(grades));
  const safeUsers = Math.max(0, Math.trunc(activeUsers));
  return {
    grades: safeGrades,
    activeUsers: safeUsers,
    perUser: safeUsers === 0 ? null : safeGrades / safeUsers,
  };
}

// ─── K-factor from share-to-earn ────────────────────────────────────────────

export interface KFactorInputs {
  /** Users who shared at least once in the window. */
  sharers: number;
  /** Shares those users produced. */
  shares: number;
  /** New signups attributable to those shares. */
  conversions: number;
}

export interface KFactorResult extends KFactorInputs {
  /** shares / sharers — how loudly a sharer shares. */
  sharesPerSharer: number | null;
  /** conversions / shares — how well a share converts. */
  conversionRate: number | null;
  /**
   * The viral coefficient: sharesPerSharer × conversionRate, which reduces to
   * conversions / sharers. Null when nobody shared.
   */
  k: number | null;
}

/**
 * The share-to-earn viral coefficient.
 *
 * ⚠ THE DENOMINATOR IS SHARERS, NOT ALL USERS, and that is a deliberate
 * narrowing worth stating because the two get conflated constantly. K over the
 * whole base answers "is the product viral". K over sharers answers "does the
 * share MECHANIC work", which is the mechanic this epic is deciding whether to
 * keep. A K above 1 here does NOT mean runaway growth — it means each person who
 * shares brings more than one person, which is only viral growth if enough
 * people share.
 *
 * Both component ratios are returned because the same K arises from very
 * different products, and the fix differs: many weak shares needs a better
 * asset, few strong shares needs a better prompt.
 */
export function shareKFactor(input: KFactorInputs): KFactorResult {
  const sharers = Math.max(0, Math.trunc(input.sharers));
  const shares = Math.max(0, Math.trunc(input.shares));
  const conversions = Math.max(0, Math.trunc(input.conversions));
  return {
    sharers,
    shares,
    conversions,
    sharesPerSharer: sharers === 0 ? null : shares / sharers,
    conversionRate: shares === 0 ? null : conversions / shares,
    k: sharers === 0 ? null : conversions / sharers,
  };
}

// ─── Milestone-grant cost per retained user ─────────────────────────────────

/** One tangible grant, as `reward_tangible_grants` already stores it. */
export interface GrantCost {
  userId: string;
  costUsd: number;
  /** Grants that were never consumed still cost nothing — see below. */
  status: string;
}

/**
 * Statuses that represent money actually committed. A grant that was refused,
 * reversed or expired unused never left the building.
 */
export const COMMITTED_GRANT_STATUSES: readonly string[] = [
  "granted",
  "consumed",
];

export interface CostPerRetainedResult {
  /** Committed spend over the window, USD. */
  costUsd: number;
  /** Retained users the spend is divided by. */
  retained: number;
  /** costUsd / retained, or null when nobody was retained. */
  perRetainedUsd: number | null;
  /** Grants ignored because their status is not committed spend. */
  uncommittedGrants: number;
}

/**
 * What a retained user cost in tangible rewards.
 *
 * ⚠ ONLY COMMITTED SPEND COUNTS. An expired or reversed grant is a line in a
 * table, not money — including it inflates the cost of retention and would argue
 * for killing a mechanic that is in fact cheap. The ignored count is returned so
 * the exclusion is visible rather than assumed.
 *
 * ⚠ AND THIS IS A COST RATIO, NOT AN ATTRIBUTION. It divides spend by retained
 * users; it does NOT claim the spend caused the retention. Pair it with the
 * holdout already recorded in `reward_nudge_sends` before drawing a causal
 * conclusion — that table has a control group and this number does not.
 */
export function costPerRetainedUser(
  grants: readonly GrantCost[],
  retained: number,
): CostPerRetainedResult {
  let costUsd = 0;
  let uncommittedGrants = 0;
  for (const g of grants) {
    if (!COMMITTED_GRANT_STATUSES.includes(g.status)) {
      uncommittedGrants++;
      continue;
    }
    const c = Number(g.costUsd);
    if (Number.isFinite(c) && c > 0) costUsd += c;
  }
  const safeRetained = Math.max(0, Math.trunc(retained));
  // Round to cents so a float sum does not surface as 12.000000000000002.
  costUsd = Math.round(costUsd * 100) / 100;
  return {
    costUsd,
    retained: safeRetained,
    perRetainedUsd: safeRetained === 0
      ? null
      : Math.round((costUsd / safeRetained) * 100) / 100,
    uncommittedGrants,
  };
}
