// Worth My Time, R1 04/12 (US-3169): how long each task actually takes.
//
// The plan is only worth anything if the numbers are honest, so this file is
// as much about what it REFUSES to claim as about what it estimates.
//
// ── THESE ARE ASSUMPTIONS, NOT MEASUREMENTS (AC2) ───────────────────────────
// Every number below is a starting assumption to be VALIDATED against real
// sessions, not a measured seller result. Nobody has timed a seller
// photographing a jacket with this app in front of them. R2 01/06 replaces
// them per seller from their own history, and until then `source` says
// `default` on every estimate so no surface can present a guess as a finding.
//
// ── NOT THE SAME NUMBERS AS THE TIME-SAVED METER (AC2) ──────────────────────
// src/lib/time-saved.ts has minutes per task too, and they are a DIFFERENT
// quantity: hypothetical manual time AVOIDED by automation, contracted to
// vault/50-business/time-saved-baseline.md and pinned three ways. These are
// hands-on minutes a seller will actually spend. Reusing those would silently
// make the marketing claim and the plan the same number, so that one could
// never move without moving the other. work-duration-independence.test.ts
// fails if this file ever imports them.
//
// ── ACTIVE MINUTES ARE NOT ELAPSED MINUTES (AC3) ────────────────────────────
// A grading job takes the seller ten seconds to start and then runs for
// minutes without them. Only the ten seconds belongs in a time budget. The
// waiting is reported separately and, crucially, NEVER becomes a same-session
// prerequisite: a plan that blocked on it would have the seller sit and watch
// a spinner when there are four other items ready.

import type { CandidateAction } from "@/lib/work-candidates";

/**
 * Bumped when a NUMBER below changes, so a stored estimate can be told from a
 * later one. A session snapshots what it was planned with (US-3167), and a
 * comparison across versions is a comparison of two different models.
 */
export const DURATION_MODEL_VERSION = 1;

/**
 * What kind of setup a task needs, and therefore what can be batched with it.
 *
 * The scheduler (R1 08/12) charges a family's setup ONCE per contiguous run
 * rather than once per item: getting the lightbox out is the same cost whether
 * one jacket follows it or eight.
 */
export const TASK_FAMILIES = ["photo", "measure", "pack", "screen"] as const;
export type TaskFamily = (typeof TASK_FAMILIES)[number];

export interface DurationEstimate {
  /** Hands-on minutes. Never includes time the seller is not present. */
  low: number;
  typical: number;
  high: number;
  family: TaskFamily;
  /**
   * Minutes to get set up for this family, charged once per contiguous batch
   * (AC4). Zero for screen work, which needs no setup at all.
   */
  setupMinutes: number;
  /**
   * Minutes this task runs WITHOUT the seller (AC3), or 0. Reported so a plan
   * can say "this will be ready in about four minutes"; never added to the
   * budget and never a reason to wait.
   */
  unattendedMinutes: number;
  /**
   * Where the number came from, and the precedence is exactly this order
   * (US-3178 AC4): `seller` is an explicit override and always wins,
   * `learned` is the median of the seller's own confirmed minutes, `default`
   * is the labeled assumption. Nothing blends them.
   */
  source: "default" | "seller" | "learned";
  /**
   * Present only on a `learned` estimate. How many of the seller's own
   * observations the median was taken over, and the range they actually
   * spanned -- so a surface can say "5 jobs, 4 to 11 minutes" rather than
   * presenting a median of five as a fact.
   */
  learnedFrom?: {
    sampleCount: number;
    observedLowMinutes: number;
    observedHighMinutes: number;
    /** Which pool answered. `solo` means the setup is counted twice; see
     *  learnedFor() in work-duration-learning.ts. */
    allocation: "per_item" | "batch_first" | "solo";
  };
  version: number;
}

/** What this module says when it has nothing honest to say (AC1). */
export interface UnestimatedTask {
  unestimated: true;
  reason: string;
}

export type DurationResult = DurationEstimate | UnestimatedTask;

export function isUnestimated(r: DurationResult): r is UnestimatedTask {
  return (r as UnestimatedTask).unestimated === true;
}

interface Spec {
  low: number;
  typical: number;
  high: number;
  family: TaskFamily;
  unattended: number;
}

/**
 * The starting assumptions, in hands-on minutes.
 *
 * Each is a guess with a reason, and the reason matters more than the number
 * because the reason is what a later measurement argues with.
 */
const DEFAULTS: Record<CandidateAction, Spec> = {
  // Four to eight flat measurements with a tape, written down. The spread is
  // mostly the garment: a t-shirt is three numbers, a structured coat is eight.
  measure: { low: 3, typical: 5, high: 9, family: "measure", unattended: 0 },
  // Front, back, tag and a detail, on a hanger or flat, with retakes. The high
  // end is a garment that needs steaming first and a defect shot after.
  photograph: { low: 4, typical: 8, high: 15, family: "photo", unattended: 0 },
  // Reading a grade, looking at the flagged photos, accepting or sending back.
  review_grade: { low: 1, typical: 3, high: 6, family: "screen", unattended: 0 },
  // Looking at sold comps and picking a number. The high end is a garment with
  // no clean comparables, where the seller goes looking.
  price_research: { low: 3, typical: 7, high: 15, family: "screen", unattended: 0 },
  // Reading a generated draft and fixing the title and specifics.
  draft_review: { low: 2, typical: 5, high: 10, family: "screen", unattended: 0 },
  // Pressing publish and watching it land. Short by design: if this is long,
  // something upstream is wrong and the fix is not a bigger estimate.
  publish: { low: 1, typical: 2, high: 5, family: "screen", unattended: 0 },
  // Fold, bag, label, tape. The high end is an awkward shape or a heavy coat.
  pack_ship: { low: 4, typical: 7, high: 14, family: "pack", unattended: 0 },
};

/**
 * Getting set up for a family, charged once per contiguous batch (AC4).
 *
 * Screen work is 0 and that is the point of the number: a plan that charged
 * setup for opening a browser tab would push every short screen task below the
 * bar and the seller would be told a five-minute job takes eight.
 */
const SETUP_MINUTES: Record<TaskFamily, number> = {
  // Lightbox or backdrop out, lights on, phone propped, one test shot.
  photo: 6,
  // Tape and a flat surface cleared.
  measure: 2,
  // Mailers, tape, scale and the printer within reach.
  pack: 4,
  screen: 0,
};

/**
 * The cost of CHANGING what you are doing (AC4).
 *
 * Not the same as a setup: this is the putting-away, the walking, and the
 * re-reading of where you were. A plan that ignored it would look better on
 * paper and run over every time.
 */
export const CONTEXT_SWITCH_MINUTES = 2;

/**
 * Minutes to charge for moving from one family to another, or 0 when staying
 * put. Exported because the scheduler in R1 08/12 is what applies it, and a
 * rule applied in two places is a rule that will eventually be applied twice.
 */
export function switchCost(from: TaskFamily | null, to: TaskFamily): number {
  if (from === null) return 0;
  if (from === to) return 0;
  return CONTEXT_SWITCH_MINUTES;
}

/**
 * What a contiguous run of one family costs in setup, given what came before.
 *
 * SETUP IS CHARGED ONCE, which is the whole reason families exist. Eight
 * photos after one lightbox setup is 6 + 8 x typical, not 8 x (6 + typical) --
 * a difference of 42 minutes on one batch, which is the difference between a
 * plan that fits an evening and one that does not.
 */
export function setupCostFor(family: TaskFamily, previous: TaskFamily | null): number {
  if (previous === family) return 0;
  return SETUP_MINUTES[family];
}

function finitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export interface EstimateInput {
  action: CandidateAction | string;
  /**
   * A seller override in minutes, when one exists. It OUTRANKS a learned
   * value, and clearing it (passing null or leaving it out) restores the
   * learned-then-default path without touching any observation -- that is
   * US-3178 AC4, and it is why this is a parameter rather than a stored
   * override baked into the learning.
   */
  overrideTypicalMinutes?: number | null;
  /**
   * What the seller's own history says for this task's family and context,
   * when there is enough of it (US-3178 AC1). Null or absent keeps the
   * labeled default, which is what a seller sees for their first five jobs.
   */
  learned?: LearnedTypical | null;
}

/**
 * The shape work-duration-learning.ts hands over.
 *
 * Declared here rather than imported so this module keeps no dependency on
 * the learning code: the estimator must stay runnable, and testable, with
 * nothing but its own defaults.
 */
export interface LearnedTypical {
  typicalMinutes: number;
  sampleCount: number;
  observedLowMinutes: number;
  observedHighMinutes: number;
  allocation: "per_item" | "batch_first" | "solo";
}

/**
 * The estimate for one task.
 *
 * DETERMINISTIC (AC5). Same input, same output, every time. Nothing here reads
 * a clock, a random number or an environment, because a plan a seller
 * re-opened and found different would be a plan they stopped trusting.
 */
export function estimateDuration(input: EstimateInput): DurationResult {
  const spec = (DEFAULTS as Record<string, Spec | undefined>)[input.action];
  if (!spec) {
    // AC1: unsupported work is UNESTIMATED, never zero minutes. A zero would
    // make an unknown task look free and sort it to the front of every plan.
    return {
      unestimated: true,
      reason: `No duration model for "${String(input.action)}".`,
    };
  }

  const override = input.overrideTypicalMinutes;
  if (override != null) {
    if (!finitePositive(override)) {
      // AC5: a nonfinite or negative override is REFUSED rather than clamped.
      // Clamping would let a corrupt stored value quietly become a plausible
      // number, and the seller would never learn their override was junk.
      return {
        unestimated: true,
        reason: "The saved duration for this task isn't a usable number.",
      };
    }
    // The spread is rebuilt around the override at the default's proportions,
    // so a seller who says "photos take me 12 minutes" still gets a range
    // rather than a single number pretending to be certain.
    const lowRatio = spec.low / spec.typical;
    const highRatio = spec.high / spec.typical;
    return {
      low: Math.max(1, Math.round(override * lowRatio)),
      typical: Math.round(override),
      high: Math.max(1, Math.round(override * highRatio)),
      family: spec.family,
      setupMinutes: SETUP_MINUTES[spec.family],
      unattendedMinutes: spec.unattended,
      source: "seller",
      version: DURATION_MODEL_VERSION,
    };
  }

  // US-3178 AC4: learned beats default, and only after the override above has
  // declined. The order is override, learned, default, top to bottom in this
  // function, and it is the whole of the precedence rule.
  const learned = input.learned;
  if (learned) {
    if (!finitePositive(learned.typicalMinutes)) {
      // Same refusal as a bad override, for the same reason. A median that is
      // not a usable number means the observations behind it are not either,
      // and quietly falling back to the default would hide that.
      return {
        unestimated: true,
        reason: "The learned duration for this task isn't a usable number.",
      };
    }
    // The RANGE IS THE SELLER'S OWN, not the default's proportions rebuilt
    // around their median. It is a measurement and there is no reason to
    // replace it with a ratio -- but it is widened to contain the median,
    // because a low above it or a high below it would render as a range that
    // excludes the number printed inside it.
    const typical = Math.round(learned.typicalMinutes);
    return {
      low: Math.max(1, Math.min(Math.round(learned.observedLowMinutes), typical)),
      typical,
      high: Math.max(typical, Math.round(learned.observedHighMinutes)),
      family: spec.family,
      setupMinutes: SETUP_MINUTES[spec.family],
      unattendedMinutes: spec.unattended,
      source: "learned",
      learnedFrom: {
        sampleCount: learned.sampleCount,
        observedLowMinutes: learned.observedLowMinutes,
        observedHighMinutes: learned.observedHighMinutes,
        allocation: learned.allocation,
      },
      version: DURATION_MODEL_VERSION,
    };
  }

  return {
    low: spec.low,
    typical: spec.typical,
    high: spec.high,
    family: spec.family,
    setupMinutes: SETUP_MINUTES[spec.family],
    unattendedMinutes: spec.unattended,
    source: "default",
    version: DURATION_MODEL_VERSION,
  };
}

/**
 * Work that runs without the seller, and how long it is likely to take (AC3).
 *
 * SEPARATE FROM THE ESTIMATOR ON PURPOSE. These are not tasks and must never
 * be scheduled: a grading job is started by a task and then finishes on its
 * own. The number exists so a plan can say when the result will be ready, and
 * for no other reason.
 */
export const UNATTENDED_WAITS = {
  /** An AI grade, from submit to result. */
  grading: 6,
  /** A steamed garment, hung, before it is photographed. */
  drying: 20,
} as const;
export type UnattendedWait = keyof typeof UNATTENDED_WAITS;

export interface WaitingResult {
  kind: UnattendedWait;
  /** Assumed minutes. An assumption, like everything else here. */
  minutes: number;
  /**
   * ALWAYS false in R1, and it is a constant rather than a computation so that
   * the one thing this must never do is visible at the call site.
   *
   * A waiting result is NOT a guaranteed same-session prerequisite (AC3). A
   * plan that blocked the next task on it would have the seller sit watching a
   * spinner while four other items are ready. The scheduler treats the item as
   * unavailable and moves on; if the wait finishes inside the session, the
   * item simply becomes available again.
   */
  blocksSession: false;
}

export function waitFor(kind: UnattendedWait): WaitingResult {
  return { kind, minutes: UNATTENDED_WAITS[kind], blocksSession: false };
}

/**
 * Total hands-on minutes for a batch, setup charged once per contiguous run
 * and a switch charged between runs.
 *
 * Exported and tested because the arithmetic is the feature: it is what makes
 * "you have 30 minutes, here is what fits" a true sentence.
 */
export function batchMinutes(
  tasks: readonly { family: TaskFamily; typical: number }[],
): number {
  let total = 0;
  let previous: TaskFamily | null = null;
  for (const task of tasks) {
    total += switchCost(previous, task.family);
    total += setupCostFor(task.family, previous);
    total += task.typical;
    previous = task.family;
  }
  return total;
}
