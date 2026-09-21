// Worth My Time, R1 07/12 (US-3172): fit a plan inside the time the seller
// actually has.
//
// The ranker (R1 06/12) says what order the work should be in. This says how
// much of it fits, and it is deliberately the pessimistic half of the feature.
//
// ── IT PLANS ON THE HIGH ESTIMATE, NOT THE TYPICAL ONE (AC1) ────────────────
// A plan built on typical minutes is right about half the time, and the half
// it is wrong about is the half where the seller runs over. Running over is
// what turns a 30-minute list into another backlog, which is the one outcome
// this whole feature exists to avoid. So the budget is spent at the HIGH end
// and a seller who is quick simply finishes early, which nobody minds.
//
// ── IT NEVER TRUNCATES AN ESTIMATE TO MAKE SOMETHING FIT (AC3) ──────────────
// A task that does not fit is OMITTED with a reason, or -- for a shipment that
// has to happen -- returned as a conflict with the budget it would actually
// need. Shaving four minutes off a parcel to claim the plan fits is a lie the
// seller discovers at the post office.
//
// ── IT IS GREEDY ON PURPOSE (AC4) ───────────────────────────────────────────
// Walk the ranked order once, take what fits. No subset search, no knapsack,
// no backtracking. A knapsack would pack the budget tighter and would also
// reorder the seller's most important work to do it, which is the opposite of
// what the ranker just decided. Bounded work is a side effect of the right
// behaviour rather than a performance compromise.

import {
  setupCostFor,
  switchCost,
  estimateDuration,
  isUnestimated,
  type TaskFamily,
} from "@/lib/work-duration";
import type { RankedTask } from "@/lib/work-ranker";

export const SCHEDULER_VERSION = 1;

/** The budget window, matching the preferences in R1 01/12. */
export const MIN_BUDGET_MINUTES = 5;
export const MAX_BUDGET_MINUTES = 240;

/**
 * How many ranked tasks the scheduler will look at (AC4).
 *
 * A seller with 4,000 items produces 4,000 candidates, and nothing past the
 * first couple of hundred can possibly reach a 240-minute plan. Truncation
 * happens AFTER ranking, so the cap drops the least important work rather than
 * an arbitrary slice -- and the result reports how many were considered, so a
 * caller can tell a short plan from a truncated one.
 */
export const MAX_CANDIDATES = 200;

export type OmissionReason =
  | "no_time_left"
  | "prerequisite_not_ready"
  | "conflict"
  | "unestimated"
  | "beyond_candidate_cap";

export interface OmittedTask {
  key: string;
  reason: OmissionReason;
  /** What it would have cost, when that is known. */
  minutes: number | null;
}

export interface ScheduledTask {
  key: string;
  itemId: string;
  family: TaskFamily;
  /** High-end active minutes for the task itself. */
  activeMinutes: number;
  /** Setup and switch charged at this position, 0 inside a batch. */
  overheadMinutes: number;
  /** Minutes into the session this task starts. */
  startsAtMinute: number;
}

export interface TimeConflict {
  key: string;
  /** Minutes this task actually needs, overhead included. */
  needsMinutes: number;
  /** A budget that would fit it, rounded up to a choosable number. */
  proposedBudgetMinutes: number;
  message: string;
}

export interface WorkPlan {
  tasks: ScheduledTask[];
  plannedMinutes: number;
  unusedMinutes: number;
  omitted: OmittedTask[];
  /**
   * Shipping work that has to happen and does not fit (AC3). Never silently
   * dropped and never shaved to fit.
   */
  conflicts: TimeConflict[];
  /**
   * When nothing fits: the shortest eligible task, so the empty state can say
   * "the smallest job here needs 12 minutes" instead of "nothing to do".
   */
  smallestEligibleMinutes: number | null;
  /** How many ranked tasks were examined. Bounded by MAX_CANDIDATES (AC4). */
  consideredCount: number;
  version: number;
}

export interface ScheduleInput {
  /** Explicit, never a clock read: the same inputs must plan the same twice. */
  now: string;
  budgetMinutes: number;
  ranked: readonly RankedTask[];
  /**
   * Prerequisite keys already satisfied outside this plan -- a photo upload
   * that finished, a grade that landed. A prerequisite that is NOT here and
   * NOT scheduled earlier in this plan makes its task unschedulable (AC2).
   */
  satisfiedKeys?: readonly string[];
  /** Overridable for tests; defaults to MAX_CANDIDATES. */
  candidateCap?: number;
}

/**
 * Round a needed budget up to something a seller can actually choose.
 *
 * The preferences screen offers 15/30/60 and a custom whole number, so a
 * proposal of "you need 37 minutes" is answerable but "36.5" is not.
 */
export function proposeBudget(needs: number): number {
  const rounded = Math.ceil(needs / 5) * 5;
  return Math.min(MAX_BUDGET_MINUTES, Math.max(MIN_BUDGET_MINUTES, rounded));
}

function familyOf(task: RankedTask): TaskFamily | null {
  const d = estimateDuration({ action: task.action });
  return isUnestimated(d) ? null : d.family;
}

function highMinutesOf(task: RankedTask): number | null {
  const d = estimateDuration({ action: task.action });
  return isUnestimated(d) ? null : d.high;
}

/**
 * Build the plan.
 *
 * Deterministic and bounded (AC1, AC4): one pass over at most `candidateCap`
 * ranked tasks, taking what fits in the order the ranker chose.
 */
export function schedulePlan(input: ScheduleInput): WorkPlan {
  const budget = Math.min(
    MAX_BUDGET_MINUTES,
    Math.max(MIN_BUDGET_MINUTES, Math.round(input.budgetMinutes || 0)),
  );
  const cap = Math.max(0, input.candidateCap ?? MAX_CANDIDATES);

  const tasks: ScheduledTask[] = [];
  const omitted: OmittedTask[] = [];
  const conflicts: TimeConflict[] = [];
  const satisfied = new Set(input.satisfiedKeys ?? []);

  let spent = 0;
  let previousFamily: TaskFamily | null = null;
  let smallestEligible: number | null = null;

  const considered = input.ranked.slice(0, cap);
  for (const task of input.ranked.slice(cap)) {
    omitted.push({ key: task.key, reason: "beyond_candidate_cap", minutes: null });
  }

  for (const task of considered) {
    const family = familyOf(task);
    const high = highMinutesOf(task);
    if (family === null || high === null) {
      // A task nobody has estimated cannot be fitted to a budget. Omitted with
      // a reason rather than assumed short, which would overfill the session.
      omitted.push({ key: task.key, reason: "unestimated", minutes: null });
      continue;
    }

    // AC2: never put a task before a prerequisite that is not ready. A step
    // scheduled earlier in THIS plan counts, which is what lets a chain be
    // partly scheduled in order.
    const blocked = task.prerequisiteKeys.some(
      (k) => !satisfied.has(k) && !tasks.some((t) => t.key === k),
    );
    if (blocked) {
      omitted.push({ key: task.key, reason: "prerequisite_not_ready", minutes: high });
      continue;
    }

    const overhead = switchCost(previousFamily, family) +
      setupCostFor(family, previousFamily);
    const cost = overhead + high;

    // The smallest thing that COULD have been scheduled, for the empty state.
    // Measured at its own overhead from a cold start, because that is what the
    // seller would actually pay if it were the only thing they did.
    const coldCost = setupCostFor(family, null) + high;
    if (smallestEligible === null || coldCost < smallestEligible) {
      smallestEligible = coldCost;
    }

    if (spent + cost > budget) {
      if (task.tier === "urgent_shipping") {
        // AC3: a shipment that has to happen and does not fit is a CONFLICT
        // with the budget it would need, never a truncated estimate. Shaving
        // four minutes off a parcel to claim the plan fits is a lie the seller
        // discovers at the post office.
        const needs = coldCost;
        conflicts.push({
          key: task.key,
          needsMinutes: needs,
          proposedBudgetMinutes: proposeBudget(needs),
          message:
            `This parcel needs about ${needs} minutes and won't fit in ${budget}.`,
        });
      }
      omitted.push({ key: task.key, reason: "no_time_left", minutes: cost });
      // Keep walking rather than stopping. A later task may be short enough to
      // fit in what is left, and a seller with eight minutes spare would
      // rather have a small job than a rounding error.
      continue;
    }

    tasks.push({
      key: task.key,
      itemId: task.itemId,
      family,
      activeMinutes: high,
      overheadMinutes: overhead,
      startsAtMinute: spent,
    });
    spent += cost;
    previousFamily = family;
  }

  return {
    tasks,
    plannedMinutes: spent,
    unusedMinutes: budget - spent,
    omitted,
    conflicts,
    // Only meaningful when nothing was scheduled; null otherwise so a caller
    // cannot render "the smallest job needs 12 minutes" beside a full plan.
    smallestEligibleMinutes: tasks.length === 0 ? smallestEligible : null,
    consideredCount: considered.length,
    version: SCHEDULER_VERSION,
  };
}

