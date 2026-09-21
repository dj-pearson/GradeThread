// Worth My Time, R2 04/06 (US-3181): why was this task chosen?
//
// A plan a seller cannot argue with is a plan they either follow blindly or
// abandon. Both are bad, and the second is what actually happens. So every
// row can be opened, and what opens is the evidence the ranker used -- not a
// paragraph about it.
//
// ── DETERMINISTIC CODES, NEVER GENERATED PROSE (AC1) ────────────────────────
// This module returns FACTS and CODES. The words live in
// work-explain-copy.ts, the same split work-advice.ts uses, and for the same
// two reasons: a test can assert the reason rather than the sentence, and a
// copy change can never alter what the explanation claims. Nothing here calls
// a model. An explanation generated from the same inputs that produced the
// decision would be a second, unverifiable account of it, and the first time
// the two disagreed nobody would know which was true.
//
// ── IT EXPLAINS THE SNAPSHOT, NOT TODAY (AC5) ───────────────────────────────
// Every figure comes from the PreparedPlan the seller was shown. Re-reading
// the item would explain a plan that was never made: the price moved, the
// photos landed, the garment sold. `takenAt` is carried so the panel can say
// when the numbers are from, and `stale` says plainly that the world has
// moved on rather than quietly showing today's answer under yesterday's
// ranking.
//
// ── NO CONFIDENCE PERCENTAGE (AC3) ──────────────────────────────────────────
// There is no calibrated source for one. `score` is cents per minute and is
// ordering only; turning it into "87% confident" would be inventing a
// statistic out of a sort key. Uncertainty is stated as the FACT that causes
// it -- only asking prices, five completed sessions, no price at all -- and a
// reader can weigh that themselves.

import type { CandidateAction } from "@/lib/work-candidates";
import type { RankedTask } from "@/lib/work-ranker";
import type { OmissionReason } from "@/lib/work-scheduler";
import type { DurationResult } from "@/lib/work-duration";
import { isUnestimated } from "@/lib/work-duration";
import { isComplete, type ValueResult } from "@/lib/work-value";

export const EXPLAIN_MODEL_VERSION = 1;

/**
 * Why a task is where it is. Codes, so a test asserts the reason.
 *
 * `urgent_deadline` and `best_rate` are the two that put a task at the top;
 * the rest are things a reader needs in order to judge that.
 */
export const EXPLAIN_FACTS = [
  "urgent_deadline",
  "deadline_unknown",
  "best_rate",
  "needs_price_research",
  "cannot_estimate_value",
  "timing_is_default",
  "timing_is_learned",
  "timing_is_override",
  "value_from_sold_comp",
  "value_from_seller_estimate",
  "value_from_asking_price",
  "value_inputs_missing",
  "clears_hourly_target",
  "below_hourly_target",
  "no_hourly_target_set",
  "blocked_by_prerequisite",
  "snapshot_may_be_stale",
] as const;
export type ExplainFact = (typeof EXPLAIN_FACTS)[number];

export interface DeadlineFacts {
  /** The deadline tier the ranker used. */
  tier: string;
  dueAt: string | null;
  /** How the ship-by date was arrived at: confirmed, estimated or unknown. */
  confidence: "confirmed" | "estimated" | "unknown";
}

export interface TimingFacts {
  /** Hands-on minutes for THIS task. */
  activeMinutes: number | null;
  /** Setup charged for the family, before batching. */
  setupMinutes: number | null;
  /** Minutes for everything the item still needs to be sale-ready. */
  chainMinutes: number;
  /** Where the number came from. Never dressed up as a measurement. */
  source: "default" | "seller" | "learned" | "unknown";
  /** Only on a learned estimate: how many of the seller's own jobs. */
  sampleCount: number | null;
  observedLowMinutes: number | null;
  observedHighMinutes: number | null;
}

export interface ValueFacts {
  /** The conservative end the ranker sorted on. Null when unvalued. */
  conservativeCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  /** sold_comp, seller_estimate, active_asking, or null. */
  evidence: string | null;
  /** When that evidence was observed. */
  observedAt: string | null;
  /** Inputs that were guessed or absent, as the estimator recorded them. */
  missing: string[];
  /** TRUE only where the estimator itself said so. Never derived here. */
  meetsHourlyTarget: boolean | null;
}

export interface TaskExplanation {
  key: string;
  action: CandidateAction | string;
  tier: string;
  /** The facts a reader needs, in the order they matter. */
  facts: ExplainFact[];
  deadline: DeadlineFacts;
  timing: TimingFacts;
  value: ValueFacts;
  /** Keys this task waits on, from the snapshot. */
  prerequisiteKeys: readonly string[];
  /** The ranker's own conflict message, when there is one. */
  conflict: { kind: string; message: string } | null;
  /**
   * When the plan was built. Carried so the panel can say what the numbers
   * are from rather than implying they are current (AC5).
   */
  takenAt: string | null;
  /** True when the snapshot is old enough to say so. */
  stale: boolean;
  version: number;
}

export interface OmissionExplanation {
  key: string;
  reason: OmissionReason;
  minutes: number | null;
  version: number;
}

export interface ExplainInput {
  task: RankedTask;
  duration: DurationResult;
  value: ValueResult;
  /** Ship-by facts as the candidate recorded them. */
  shipBy?: { at: string | null; confidence: "confirmed" | "estimated" | "unknown" };
  /** When the plan snapshot was taken. */
  takenAt?: string | null;
  /** Server time, passed in so this stays pure and testable. */
  now?: string | null;
  hourlyTargetSet?: boolean;
}

/**
 * How old a snapshot has to be before the panel says so.
 *
 * An evening's plan is fine; a plan reopened the next day is explaining a
 * world that has moved. The number is an assumption, like every other one in
 * this feature, and it is named so a later measurement can argue with it.
 */
export const STALE_SNAPSHOT_HOURS = 12;

function timingFacts(duration: DurationResult, chainMinutes: number): TimingFacts {
  if (isUnestimated(duration)) {
    return {
      activeMinutes: null,
      setupMinutes: null,
      chainMinutes,
      source: "unknown",
      sampleCount: null,
      observedLowMinutes: null,
      observedHighMinutes: null,
    };
  }
  return {
    activeMinutes: duration.typical,
    setupMinutes: duration.setupMinutes,
    chainMinutes,
    source: duration.source,
    sampleCount: duration.learnedFrom?.sampleCount ?? null,
    observedLowMinutes: duration.learnedFrom?.observedLowMinutes ?? null,
    observedHighMinutes: duration.learnedFrom?.observedHighMinutes ?? null,
  };
}

function valueFacts(value: ValueResult, task: RankedTask): ValueFacts {
  if (!isComplete(value)) {
    return {
      conservativeCents: task.conservativeCents,
      lowCents: null,
      highCents: null,
      evidence: null,
      observedAt: null,
      missing: [...value.missing],
      meetsHourlyTarget: task.meetsHourlyTarget,
    };
  }
  return {
    conservativeCents: task.conservativeCents,
    lowCents: value.lowCents,
    highCents: value.highCents,
    evidence: value.evidence,
    observedAt: value.observedAt,
    missing: [...value.missing],
    meetsHourlyTarget: task.meetsHourlyTarget,
  };
}

function hoursBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / 3_600_000;
}

/**
 * Explain one ranked task, from the snapshot it was ranked in.
 *
 * PURE and deterministic. `now` is a parameter, nothing is fetched, and the
 * same snapshot explains the same way tomorrow -- which is the whole of AC5.
 */
export function explainTask(input: ExplainInput): TaskExplanation {
  const { task } = input;
  const facts: ExplainFact[] = [];

  // ── why it is where it is ────────────────────────────────────────
  if (task.tier === "urgent_shipping") {
    facts.push("urgent_deadline");
    if ((input.shipBy?.confidence ?? "unknown") === "unknown") {
      // A deadline nobody confirmed is still a deadline, and saying which is
      // which is the difference between a seller trusting the tier and
      // ignoring it.
      facts.push("deadline_unknown");
    }
  } else if (task.tier === "valued_work") {
    facts.push("best_rate");
  } else if (task.tier === "research") {
    facts.push("needs_price_research");
  } else if (task.tier === "unvalued") {
    facts.push("cannot_estimate_value");
  }

  // ── where the minutes came from (AC2) ────────────────────────────
  const timing = timingFacts(input.duration, task.chainMinutes);
  if (timing.source === "default") facts.push("timing_is_default");
  if (timing.source === "learned") facts.push("timing_is_learned");
  if (timing.source === "seller") facts.push("timing_is_override");

  // ── where the money came from (AC2, AC3) ─────────────────────────
  const value = valueFacts(input.value, task);
  if (value.evidence === "sold_comp") facts.push("value_from_sold_comp");
  if (value.evidence === "seller_estimate") facts.push("value_from_seller_estimate");
  // THE ONE THAT MATTERS MOST. An unsold listing at $200 is evidence that
  // $200 did not sell, and a plan built on one should read as the guess it is.
  if (value.evidence === "active_asking") facts.push("value_from_asking_price");
  if (value.missing.length > 0) facts.push("value_inputs_missing");

  if (!input.hourlyTargetSet) facts.push("no_hourly_target_set");
  else if (task.meetsHourlyTarget === true) facts.push("clears_hourly_target");
  else if (task.meetsHourlyTarget === false) facts.push("below_hourly_target");

  if (task.prerequisiteKeys.length > 0) facts.push("blocked_by_prerequisite");

  const ageHours = hoursBetween(input.takenAt ?? null, input.now ?? null);
  const stale = ageHours !== null && ageHours >= STALE_SNAPSHOT_HOURS;
  if (stale) facts.push("snapshot_may_be_stale");

  return {
    key: task.key,
    action: task.action,
    tier: task.tier,
    facts,
    deadline: {
      tier: task.tier,
      dueAt: task.dueAt,
      confidence: input.shipBy?.confidence ?? "unknown",
    },
    timing,
    value,
    prerequisiteKeys: task.prerequisiteKeys,
    conflict: task.conflict
      ? { kind: task.conflict.kind, message: task.conflict.message }
      : null,
    takenAt: input.takenAt ?? null,
    stale,
    version: EXPLAIN_MODEL_VERSION,
  };
}

/**
 * Why a task did NOT make the plan (AC4).
 *
 * A thin function on purpose: the scheduler already decided and recorded the
 * reason, and re-deriving it here would be a second opinion that could
 * disagree with the plan it is explaining.
 */
export function explainOmission(
  omitted: { key: string; reason: OmissionReason; minutes: number | null },
): OmissionExplanation {
  return {
    key: omitted.key,
    reason: omitted.reason,
    minutes: omitted.minutes,
    version: EXPLAIN_MODEL_VERSION,
  };
}

/**
 * The single fact that would most change this ranking, or null (AC4).
 *
 * ONE, not a list. A panel that ends with five things to go and fix is a
 * panel nobody acts on, and the ordering here is by how much the answer would
 * move: no value at all beats a weak price, which beats a guessed cost.
 */
export function whatWouldChangeIt(explanation: TaskExplanation): ExplainFact | null {
  const ordered: ExplainFact[] = [
    "cannot_estimate_value",
    "needs_price_research",
    "value_from_asking_price",
    "value_inputs_missing",
    "deadline_unknown",
    "timing_is_default",
  ];
  return ordered.find((f) => explanation.facts.includes(f)) ?? null;
}
