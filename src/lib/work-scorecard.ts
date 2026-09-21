// Worth My Time, R2 06/06 (US-3183): what actually happened, said honestly.
//
// This is the screen the whole feature has been building toward and it is also
// the one with the strongest pull toward a lie. "You made $340 at $28/hour"
// is what a seller wants to read, it is what every competing tool prints, and
// almost every version of it is false: it counts sourcing and admin time that
// was never tracked, it books a refund as a win, it turns stock that has not
// sold into a zero, and it treats a number the planner GUESSED as money.
//
// ── THREE NUMBERS THAT ARE NEVER ONE NUMBER (AC2) ───────────────────────────
// Projected value, realized net and profit per tracked hour are separate
// fields with separate names, and nothing here adds them together. Projection
// is what the planner said a garment might make; realized is what the books
// recorded; the rate is realized money over CONFIRMED minutes. A screen that
// blends them produces a figure that is neither, and the seller has no way to
// tell which half is imaginary.
//
// ── PROFIT PER TRACKED HOUR IS NOT AN HOURLY WAGE (AC2) ─────────────────────
// The denominator is the minutes a seller confirmed inside a work session.
// Sourcing, driving, photographing before they started tracking, answering
// buyer messages and bookkeeping are all absent from it, so the true hourly
// return on their business is LOWER than this number, always. The field is
// named profitPerTrackedHourCents and the copy says so; calling it "your
// hourly rate" would be the single most misleading thing this feature could
// print.
//
// ── UNAVAILABLE IS AN ANSWER (AC3) ──────────────────────────────────────────
// Zero tracked minutes is not an infinite rate. No completed sale is not a
// zero rate. Sales whose costs were never recorded are not free garments. Each
// one returns { available: false, reason } and the screen prints the reason.
// The tempting alternatives -- Infinity, NaN, a fabricated 0 -- all render as
// a number a seller would believe.
//
// ── UNSOLD STOCK SITS BESIDE THE WINS (AC3) ─────────────────────────────────
// `pending` carries the count AND the tracked minutes of work that has not
// sold yet. Without it a scorecard can look excellent by reporting only the
// garments that worked, which is survivorship bias with a chart on it.
//
// ── IT DESCRIBES, IT DOES NOT CLAIM CAUSE (AC4) ─────────────────────────────
// compareRanges returns two periods' figures and their differences and calls
// them differences. It does not say the planner caused them, does not project
// them forward, and does not generalise from one seller to the product. With
// samples this size that would be a story dressed as a finding.
//
// ── CONFIRMED MINUTES, NEVER THE HYPOTHETICAL METER (AC5) ───────────────────
// src/lib/time-saved.ts holds assumed minutes per automated task -- 8 minutes
// for comps, 6 for a description -- and they are a marketing baseline, not a
// measurement of this seller. Feeding them into a denominator here would
// produce a profit-per-hour figure computed from numbers nobody observed. This
// module does not import it, and work-scorecard.test.ts fails if it starts.

import { EVIDENCE_SOURCES } from "@/lib/work-value";
import { PLANNING_HORIZON_DAYS } from "@/lib/work-value";
import {
  OUTCOME_STATES,
  type EstimateSource,
  type Outcome,
  type OutcomeState,
  type PlannedTask,
} from "@/lib/work-outcomes";

export const SCORECARD_VERSION = 1;

/** Why a figure cannot be stated. Codes, so a test asserts the reason. */
export const UNAVAILABLE_REASONS = [
  "no_tracked_time",
  "no_completed_sales",
  "costs_not_recorded",
  "nothing_in_range",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type Stat =
  | { available: true; cents: number }
  | { available: false; reason: UnavailableReason };

export interface ScorecardRange {
  /** Inclusive ISO bounds, or null for open. */
  from: string | null;
  to: string | null;
}

export interface WorkDone {
  /** Tasks the seller marked done inside the range. */
  completedTasks: number;
  /** Minutes they CONFIRMED. Never a clock's guess, never an assumption. */
  confirmedMinutes: number;
  /** Sessions those tasks belong to. */
  sessions: number;
  /** Items planned but not finished, carried into a later evening. */
  carriedForwardItems: number;
}

export interface PendingStock {
  /** Items worked on that have not sold. */
  items: number;
  /** Minutes already spent on them. The cost of the unsold half. */
  trackedMinutes: number;
}

export interface ForecastVsActual {
  /** How many items have BOTH an estimate and a recorded result. */
  sampleSize: number;
  estimatedTotalCents: number;
  recordedTotalCents: number;
  /** Per-item differences, so a range can be printed rather than a mean. */
  lowestDifferenceCents: number | null;
  highestDifferenceCents: number | null;
  medianDifferenceCents: number | null;
  /** How many items each kind of price evidence produced (AC4). */
  bySource: Record<EstimateSource, number>;
  /** The window R1 made the estimate for. */
  horizonDays: number;
}

export interface Scorecard {
  range: ScorecardRange;
  work: WorkDone;
  counts: Record<OutcomeState, number>;
  /**
   * What the planner GUESSED these garments might net. A projection against
   * sales that have not happened, kept apart from every recorded figure.
   */
  projectedNetCents: number;
  /** The books' own net for the sales that completed. Never a projection. */
  realized: Stat;
  /** Realized net over confirmed minutes. NOT an hourly wage (AC2). */
  profitPerTrackedHour: Stat;
  /**
   * Sold items left OUT of the two figures above because their costs were
   * never recorded. Reported so the scorecard cannot look good by dropping
   * them (AC3).
   */
  excludedForIncompleteCosts: number;
  pending: PendingStock;
  forecast: ForecastVsActual;
  version: number;
}

export interface ScorecardInput {
  outcomes: readonly Outcome[];
  /** The raw tasks, for the done/carried counts the outcomes do not carry. */
  tasks: readonly PlannedTask[];
  range?: Partial<ScorecardRange>;
  horizonDays?: number;
}

/**
 * Task states that mean the seller finished the job.
 *
 * `completed` is the one the table actually stores (00818's CHECK allows
 * pending, active, completed, skipped, invalidated). "done" is kept because
 * that is the word the API route uses for the action, and a caller handing
 * either spelling should get the same count.
 */
const DONE_STATES = new Set(["done", "completed"]);

/**
 * Task states that mean the job is carried into another evening.
 *
 * SKIPPED COUNTS, the same way sessionProgress's leftOverCount counts it: a
 * job the seller passed over is work they still have to do, and leaving it
 * out would let a session that skipped everything report nothing carried.
 * `invalidated` does NOT count -- the garment sold or moved, so there is no
 * work left to carry.
 */
const OPEN_STATES = new Set(["pending", "active", "skipped"]);

function withinRange(iso: string | null, range: ScorecardRange): boolean {
  // NO DATE means it is not in any range. A task with no estimate timestamp
  // cannot be placed in a period, and putting it in every period would make
  // two adjacent ranges sum to more than the whole.
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  if (range.from) {
    const f = Date.parse(range.from);
    if (Number.isFinite(f) && t < f) return false;
  }
  if (range.to) {
    const to = Date.parse(range.to);
    if (Number.isFinite(to) && t > to) return false;
  }
  return true;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Build the scorecard for one date range.
 *
 * PURE. No clock, no fetch. `now` was already applied upstream when the
 * outcomes were classified, so the same rows produce the same scorecard in a
 * test, in a browser, and next week.
 */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const range: ScorecardRange = {
    from: input.range?.from ?? null,
    to: input.range?.to ?? null,
  };
  const horizonDays = input.horizonDays ?? PLANNING_HORIZON_DAYS;

  const inRange = input.outcomes.filter((o) => withinRange(o.estimatedAt, range));

  // ── the work itself ───────────────────────────────────────────────
  // Counted off the TASKS, because an outcome is one garment and a garment can
  // be four jobs. "How much did I get through" is a question about jobs.
  const rangedTasks = input.tasks.filter((t) => withinRange(t.estimateTakenAt, range));
  const work: WorkDone = {
    completedTasks: rangedTasks.filter((t) => DONE_STATES.has(t.taskState)).length,
    // CONFIRMED, and a later correction wins over the original answer -- the
    // same precedence lib/work-sessions.ts owns. A task finished without an
    // answer contributes nothing, which is why this can read lower than the
    // wall clock and should.
    confirmedMinutes: rangedTasks.reduce(
      (sum, t) => sum + (t.correctionMinutes ?? t.confirmedMinutes ?? 0),
      0,
    ),
    sessions: new Set(rangedTasks.map((t) => t.sessionId)).size,
    carriedForwardItems: new Set(
      rangedTasks
        .filter((t) => OPEN_STATES.has(t.taskState) && t.inventoryItemId !== null)
        .map((t) => t.inventoryItemId),
    ).size,
  };

  const counts = Object.fromEntries(
    OUTCOME_STATES.map((s) => [s, 0]),
  ) as Record<OutcomeState, number>;
  const bySource = Object.fromEntries(
    [...EVIDENCE_SOURCES, "unknown"].map((s) => [s, 0]),
  ) as Record<EstimateSource, number>;

  let projectedNetCents = 0;
  let realizedTotal = 0;
  let realizedMinutes = 0;
  let settledItems = 0;
  let excludedForIncompleteCosts = 0;
  const pending: PendingStock = { items: 0, trackedMinutes: 0 };
  const differences: number[] = [];
  let estimatedTotalCents = 0;
  let recordedTotalCents = 0;
  let sampleSize = 0;

  for (const o of inRange) {
    counts[o.state] += 1;
    bySource[o.estimateSource] += 1;
    if (o.estimatedNetCents != null) projectedNetCents += o.estimatedNetCents;

    if (o.state === "incomplete_costs") {
      // The garment DID sell and we still cannot say what it made. It is not
      // a zero and it is not dropped: it is counted here and named on screen.
      excludedForIncompleteCosts += 1;
      continue;
    }

    if (o.state === "pending" || o.state === "not_sold_within_horizon") {
      // AC3: the unsold half, with the hours it already cost.
      pending.items += 1;
      pending.trackedMinutes += o.confirmedMinutes;
      continue;
    }

    if (o.state === "sold" || o.state === "refunded") {
      if (o.recordedNetCents == null) {
        excludedForIncompleteCosts += 1;
        continue;
      }
      // ONE ITEM, COUNTED ONCE (AC2). `outcomes` is already keyed by item, and
      // its confirmedMinutes already sums every session that touched it, so a
      // garment planned three times contributes one sale and all its hours.
      settledItems += 1;
      realizedTotal += o.recordedNetCents;
      realizedMinutes += o.confirmedMinutes;
      if (o.estimatedNetCents != null) {
        sampleSize += 1;
        estimatedTotalCents += o.estimatedNetCents;
        recordedTotalCents += o.recordedNetCents;
        differences.push(o.recordedNetCents - o.estimatedNetCents);
      }
    }
  }

  const realized: Stat = inRange.length === 0
    ? { available: false, reason: "nothing_in_range" }
    : settledItems === 0
    ? {
      available: false,
      // Two different answers, because they mean different things to a
      // seller: "nothing has sold yet" is patience, "the costs were never
      // recorded" is a thing they can go and fix.
      reason: excludedForIncompleteCosts > 0 ? "costs_not_recorded" : "no_completed_sales",
    }
    : { available: true, cents: realizedTotal };

  const profitPerTrackedHour: Stat = !realized.available
    ? realized
    : realizedMinutes <= 0
    // ⚠ NEVER Infinity, NEVER a fabricated zero (AC3). A sale with no tracked
    // minutes against it has no rate, and both of the arithmetic answers here
    // render as a number a seller would believe.
    ? { available: false, reason: "no_tracked_time" }
    : { available: true, cents: Math.round((realizedTotal * 60) / realizedMinutes) };

  return {
    range,
    work,
    counts,
    projectedNetCents,
    realized,
    profitPerTrackedHour,
    excludedForIncompleteCosts,
    pending,
    forecast: {
      sampleSize,
      estimatedTotalCents,
      recordedTotalCents,
      lowestDifferenceCents: differences.length > 0 ? Math.min(...differences) : null,
      highestDifferenceCents: differences.length > 0 ? Math.max(...differences) : null,
      medianDifferenceCents: median(differences),
      bySource,
      horizonDays,
    },
    version: SCORECARD_VERSION,
  };
}

export interface RangeComparison {
  earlier: Scorecard;
  later: Scorecard;
  /** Plain differences. NOT a claim that anything caused them (AC4). */
  differences: {
    completedTasks: number;
    confirmedMinutes: number;
    /** Null whenever either period could not state a realized figure. */
    realizedNetCents: number | null;
    profitPerTrackedHourCents: number | null;
  };
  /** The smaller of the two sample sizes: how much this is worth reading. */
  smallestSampleSize: number;
  version: number;
}

/**
 * Two periods, side by side (AC4).
 *
 * DESCRIPTIVE ONLY, and that is a rule rather than a caveat. A seller who
 * used the planner in March and not in February differed in a dozen other
 * ways -- what they sourced, what the season was, how much time they had --
 * and with samples this size the difference between the two months is mostly
 * which garments happened to sell. So this returns differences, names the
 * smaller sample, and says nothing about why.
 */
export function compareRanges(earlier: Scorecard, later: Scorecard): RangeComparison {
  const diffStat = (a: Stat, b: Stat): number | null =>
    a.available && b.available ? b.cents - a.cents : null;
  return {
    earlier,
    later,
    differences: {
      completedTasks: later.work.completedTasks - earlier.work.completedTasks,
      confirmedMinutes: later.work.confirmedMinutes - earlier.work.confirmedMinutes,
      realizedNetCents: diffStat(earlier.realized, later.realized),
      profitPerTrackedHourCents: diffStat(
        earlier.profitPerTrackedHour,
        later.profitPerTrackedHour,
      ),
    },
    smallestSampleSize: Math.min(earlier.forecast.sampleSize, later.forecast.sampleSize),
    version: SCORECARD_VERSION,
  };
}

/**
 * Is this sample big enough to read as anything but anecdote?
 *
 * A NAMED CONSTANT WITH A TEST, so the screen and the copy cannot disagree
 * about when to hedge. Ten is not a statistical threshold and is not claimed
 * to be one: it is the point below which a single unusual garment moves the
 * median, and it is here so a reader can argue with a number rather than with
 * a vibe.
 */
export const THIN_SAMPLE_BELOW = 10;

export function isThinSample(sampleSize: number): boolean {
  return sampleSize < THIN_SAMPLE_BELOW;
}
