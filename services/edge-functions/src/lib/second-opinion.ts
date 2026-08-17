// US-2279: a selective second-opinion pass — re-run the COMPOSITE stage under a
// second allowlisted model on the grades where being wrong costs the most, and
// route real disagreement to a human.
//
// WHY SELECTIVE AND NOT ALWAYS. A second composite is a second model call per
// graded item. Run on everything it roughly doubles composite spend to re-confirm
// grades that were never in doubt; run on the borderline band it buys a genuine
// second read on the items most likely to be wrong. The budget maths is at the
// bottom of this header and is part of the contract, not commentary.
//
// WHY THE BAND STARTS ABOVE THE REVIEW THRESHOLD, which is the one thing about
// the trigger that looks backwards. A grade already below
// GRADING_REVIEW_CONFIDENCE_THRESHOLD is ALREADY going to a human. Spending a
// second vision call to discover that it should go to a human changes nothing
// and costs money. The interesting band is the one just ABOVE the line: grades
// confident enough to ship unreviewed, and close enough to the line that a
// second opinion could legitimately move them. Below the line we skip; well
// above it we skip.
//
// WHAT DISAGREEMENT MEANS HERE. Not "the models differ" — two composites of the
// same evidence will always differ in the last decimal. Disagreement is |Δ| in
// GRADE POINTS exceeding epsilon, defaulting to 0.5, which is one full tier
// (Excellent 8 vs Very Good 7 is 1.0; half of that is the smallest gap worth a
// human's time). Below epsilon the second read is CONFIRMATION and we say so;
// above it, the grade is capped under the review threshold and routed.
//
// ⚠ THE CAP DOES BOTH HALVES (US-2299). A cap that lowers confidence without
// lowering the reported ceiling is invisible: the review gate fires, the grade
// looks handled, and the next provenance boost lifts the STORED number back over
// the cap — and the stored number is what the public confidence label and the
// calibration miner read. `secondOpinionCap` is composed through
// composeConfidenceCap by the caller AND the caller lowers confidenceCeiling,
// exactly like the peer-norm block it sits beside.
//
// ⚠ THE SECOND MODEL MUST BE ON THE GRADING ALLOWLIST. An unvetted model would
// change grading behaviour and reproducibility through a settings row rather
// than through the prompt-version lifecycle, which is the thing that lifecycle
// exists to prevent. `resolveSecondOpinionConfig` refuses one and disables the
// feature rather than silently falling back to the default model — falling back
// would run the SAME model twice and report agreement, which is worse than not
// running: it manufactures evidence.
//
// COST + LATENCY BUDGET (AC4).
//   Cost.   One extra composite per triggered item. The composite is a text-only
//           synthesis of the per-image analyses, so it is the CHEAP stage — the
//           per-image vision calls, which dominate spend, are NOT repeated. With
//           the default band (0.75-0.85) the trigger is expected to catch a
//           single-digit percentage of grades, so the fleet cost is a small
//           fraction of one stage rather than a doubling of anything.
//   Latency. One extra sequential composite on triggered items only. Untriggered
//           items are byte-identical and pay nothing, including no settings read
//           beyond the one this module already makes.
//   Ceiling. `maxPerHour` bounds the blast radius of a misconfigured band: set it
//           and a runaway trigger degrades to "no second opinion" rather than to
//           an unbounded spend. The counter is caller-supplied so this module
//           stays pure.

import { isAllowedGradingModel } from "./ai-config.ts";

/** Grade points. One tier is 1.0; the default epsilon is half a tier. */
export const DEFAULT_DISAGREEMENT_EPSILON = 0.5;

/**
 * The confidence the grade is capped to when the two models materially disagree.
 * Deliberately BELOW the 0.75 review threshold rather than equal to it: equal
 * would leave the routing decision resting on a floating-point comparison.
 */
export const SECOND_OPINION_DISAGREE_CAP = 0.6;

export interface SecondOpinionConfig {
  enabled: boolean;
  /** Lower edge of the borderline band (inclusive). Below this a human already sees it. */
  bandMin: number;
  /** Upper edge (exclusive). Above this the grade is not borderline. */
  bandMax: number;
  /** Item value at or above which a grade is re-read regardless of the band. */
  highValueMin: number | null;
  /** Grade-point difference above which the two models are held to disagree. */
  epsilon: number;
  /** Second model. Must be on GRADING_MODEL_ALLOWLIST. */
  model: string;
  /** Optional ceiling on triggers per hour; null = unbounded. */
  maxPerHour: number | null;
}

export const DEFAULT_SECOND_OPINION_CONFIG: SecondOpinionConfig = {
  // OFF by design. This is an additive stage; a deploy must not start spending
  // on it because a default flipped. Turning it on is a settings row.
  enabled: false,
  bandMin: 0.75,
  bandMax: 0.85,
  highValueMin: null,
  epsilon: DEFAULT_DISAGREEMENT_EPSILON,
  model: "claude-opus-4-8",
  maxPerHour: null,
};

/**
 * Merge an operator settings row over the defaults and REFUSE anything unsafe.
 *
 * Pure. Returns a config whose `enabled` is only ever true when every field it
 * depends on is usable — so a caller can trust `enabled` alone and does not have
 * to re-validate. A refusal is reported rather than swallowed.
 */
export function resolveSecondOpinionConfig(
  raw: Partial<SecondOpinionConfig> | null | undefined,
): { config: SecondOpinionConfig; refusal: string | null } {
  const cfg: SecondOpinionConfig = { ...DEFAULT_SECOND_OPINION_CONFIG, ...(raw ?? {}) };
  if (!cfg.enabled) return { config: { ...cfg, enabled: false }, refusal: null };

  const model = String(cfg.model ?? "").trim();
  if (!model || !isAllowedGradingModel(model)) {
    // Refusing rather than defaulting: the default IS the primary model, so a
    // fallback would grade twice with one model and report agreement — evidence
    // that was manufactured rather than gathered.
    return {
      config: { ...cfg, enabled: false },
      refusal:
        `second-opinion model "${model || "(unset)"}" is not on the grading ` +
        `allowlist; the pass is disabled rather than run against the primary model`,
    };
  }
  const bandOk =
    Number.isFinite(cfg.bandMin) && Number.isFinite(cfg.bandMax) &&
    cfg.bandMin >= 0 && cfg.bandMax <= 1 && cfg.bandMin < cfg.bandMax;
  if (!bandOk) {
    return {
      config: { ...cfg, enabled: false },
      refusal: `second-opinion band [${cfg.bandMin}, ${cfg.bandMax}) is not a valid confidence range`,
    };
  }
  if (!Number.isFinite(cfg.epsilon) || cfg.epsilon <= 0) {
    return {
      config: { ...cfg, enabled: false },
      refusal: `second-opinion epsilon ${cfg.epsilon} must be a positive number of grade points`,
    };
  }
  return { config: { ...cfg, model }, refusal: null };
}

export interface TriggerInput {
  /** Composite confidence BEFORE any second opinion. */
  confidence: number;
  /** Item value if the caller has one; null when no value signal is available. */
  itemValue: number | null;
  /** True when something has already routed this grade to a human. */
  alreadyNeedsReview: boolean;
  /** Triggers already spent this hour, for the maxPerHour ceiling. */
  triggersThisHour?: number;
}

export interface TriggerDecision {
  trigger: boolean;
  /** Why — recorded on the report so a spend line is always explainable. */
  reason: string;
}

/**
 * Should this grade get a second opinion? Pure.
 *
 * Order matters and is deliberate: the cheap disqualifiers run first, so an
 * item that is already going to a human never consults the band at all.
 */
export function shouldSeekSecondOpinion(
  input: TriggerInput,
  config: SecondOpinionConfig,
): TriggerDecision {
  if (!config.enabled) return { trigger: false, reason: "disabled" };
  if (input.alreadyNeedsReview) {
    // The whole value of this pass is changing where a grade GOES. This one is
    // already going to a person.
    return { trigger: false, reason: "already routed to human review" };
  }
  if (
    config.maxPerHour !== null &&
    (input.triggersThisHour ?? 0) >= config.maxPerHour
  ) {
    return { trigger: false, reason: `hourly ceiling reached (${config.maxPerHour})` };
  }

  const highValue =
    config.highValueMin !== null &&
    input.itemValue !== null &&
    input.itemValue >= config.highValueMin;
  if (highValue) {
    return {
      trigger: true,
      reason: `high value (${input.itemValue} >= ${config.highValueMin})`,
    };
  }

  const inBand = input.confidence >= config.bandMin && input.confidence < config.bandMax;
  if (inBand) {
    return {
      trigger: true,
      reason: `borderline confidence ${input.confidence.toFixed(2)} in [${config.bandMin}, ${config.bandMax})`,
    };
  }
  return {
    trigger: false,
    reason: `confidence ${input.confidence.toFixed(2)} outside [${config.bandMin}, ${config.bandMax})`,
  };
}

export interface DisagreementVerdict {
  /** |primary - second|, rounded to a tenth like every other grade number. */
  delta: number;
  disagree: boolean;
  /** Cap to compose when they disagree; null when they agree (compose is a no-op). */
  confidenceCap: number | null;
  needsHumanReview: boolean;
  /** The detailed_notes line. Always set — a confirmation is worth recording too. */
  note: string;
}

/** Grade numbers round to 0.1 everywhere in this system; the delta does too. */
function roundTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compare the two composites. Pure.
 *
 * A CONFIRMATION IS RECORDED, not just a disagreement. Without it a reader
 * cannot tell "the second model agreed" from "the second model never ran", and
 * those are the two states this feature exists to distinguish.
 */
export function evaluateSecondOpinion(
  primaryScore: number,
  secondScore: number,
  config: SecondOpinionConfig,
): DisagreementVerdict {
  const delta = roundTenth(Math.abs(primaryScore - secondScore));
  // Strictly greater than epsilon: a delta EQUAL to the threshold is the
  // agreement the threshold was chosen to tolerate.
  const disagree = delta > config.epsilon;
  if (!disagree) {
    return {
      delta,
      disagree: false,
      confidenceCap: null,
      needsHumanReview: false,
      note:
        `Second opinion (${config.model}) graded ${secondScore.toFixed(1)} vs ` +
        `${primaryScore.toFixed(1)} — agreement within ${config.epsilon} (Δ ${delta.toFixed(1)}).`,
    };
  }
  return {
    delta,
    disagree: true,
    confidenceCap: SECOND_OPINION_DISAGREE_CAP,
    needsHumanReview: true,
    note:
      `Second opinion (${config.model}) graded ${secondScore.toFixed(1)} vs ` +
      `${primaryScore.toFixed(1)} — Δ ${delta.toFixed(1)} exceeds ${config.epsilon}, ` +
      `routed for human review.`,
  };
}
