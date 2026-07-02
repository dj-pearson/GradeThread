// US-1536 chunk 1: peer-norm sanity check — pure statistics core.
//
// Compares a fresh composite grade against the distribution of past FINAL grades
// (human-adjusted where reviewed) for SIMILAR items. A grade that lands well
// outside the peer inter-quartile range is confidence-capped and routed to human
// review with the peer context shown to the reviewer. Independent audit — peer
// grades are NEVER fed into the grading prompt (that would anchor the model);
// this checks the model's independent output after the fact.
//
// This module is the deterministic math + decision only. The peer-profile SQL
// query (+ any index migration), the grading-pipeline wiring, the reviewer-UI
// distribution line, and the system_settings config keys are wired in follow-up
// chunks. Kept pure so it is fully unit-testable with no DB / AI call.

// Cap sits just under the 0.75 human-review threshold so a peer-norm outlier is
// always routed to a reviewer — matching PARTIAL_IMAGE_CONFIDENCE_CAP and the
// other confidence caps in grading-pipeline.ts (composed via min-of-caps).
export const PEER_NORM_CONFIDENCE_CAP = 0.7;

export interface PeerNormConfig {
  enabled: boolean;
  /** No-op below this sample size (mirrors the transparency page's n<10 gate). */
  minSampleSize: number;
  /** Grade points beyond the peer IQR before a grade is flagged an outlier. */
  iqrMarginPoints: number;
}

export const DEFAULT_PEER_NORM_CONFIG: PeerNormConfig = {
  enabled: true,
  minSampleSize: 10,
  iqrMarginPoints: 1.0,
};

export interface PeerDistribution {
  sampleSize: number;
  median: number;
  p25: number;
  p75: number;
}

/**
 * Linear-interpolation quartiles over a set of final grades. Returns null for an
 * empty set. Ignores non-finite values.
 */
export function computePeerQuartiles(values: number[]): PeerDistribution | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const q = (p: number): number => {
    if (xs.length === 1) return xs[0]!;
    const idx = p * (xs.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return xs[lo]!;
    return xs[lo]! + (xs[hi]! - xs[lo]!) * (idx - lo);
  };
  return { sampleSize: xs.length, median: q(0.5), p25: q(0.25), p75: q(0.75) };
}

export interface PeerNormResult {
  flagged: boolean;
  /** Human-readable peer context for the reviewer, or null when not flagged. */
  reason: string | null;
  /** Confidence ceiling to compose (min) with existing caps, or null. */
  confidenceCap: number | null;
}

const NOT_FLAGGED: PeerNormResult = {
  flagged: false,
  reason: null,
  confidenceCap: null,
};

/**
 * Decide whether `overallGrade` is a peer-norm outlier relative to `dist`.
 * No-op (not flagged) when disabled or the sample is too thin — errs toward
 * NOT capping so a sparse category never over-triggers human review.
 */
export function evaluatePeerNorm(
  overallGrade: number,
  dist: PeerDistribution | null,
  config: PeerNormConfig = DEFAULT_PEER_NORM_CONFIG,
): PeerNormResult {
  if (!config.enabled) return NOT_FLAGGED;
  if (!dist || dist.sampleSize < config.minSampleSize) return NOT_FLAGGED;

  const lower = dist.p25 - config.iqrMarginPoints;
  const upper = dist.p75 + config.iqrMarginPoints;
  if (overallGrade >= lower && overallGrade <= upper) return NOT_FLAGGED;

  const direction = overallGrade > upper ? "above" : "below";
  const reason =
    `peer_norm: grade ${overallGrade.toFixed(1)} is ${direction} the similar-item ` +
    `range ${dist.p25.toFixed(1)}–${dist.p75.toFixed(1)} ` +
    `(median ${dist.median.toFixed(1)}, n=${dist.sampleSize})`;
  return { flagged: true, reason, confidenceCap: PEER_NORM_CONFIDENCE_CAP };
}

/**
 * Compose a peer-norm cap with the current confidence: the lower (more
 * conservative) value wins, so peer-norm never RAISES confidence and stacks
 * correctly with the pipeline's other caps.
 */
export function composeConfidenceCap(
  currentConfidence: number,
  cap: number | null,
): number {
  return cap == null ? currentConfidence : Math.min(currentConfidence, cap);
}
