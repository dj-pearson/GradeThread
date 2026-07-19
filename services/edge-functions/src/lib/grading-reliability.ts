// AI grading self-consistency math (US-481).
//
// Reproducibility is the whole value prop of a "standardized" grade: the SAME
// garment, graded twice, must land on the SAME score (or within one grading
// increment).
//
// ⚠️ US-2035: this file used to say grading is "pinned to a low temperature (see
// getGradingTemperature in ai-config.ts)" so the model "decodes near-greedily".
// That is FALSE on the default model — claude-sonnet-5 is effort-based, takes no
// temperature, and decodes non-greedily. See the US-2035 block in ai-config.ts.
//
// That makes this module MORE important, not less: it is the only thing that
// could detect the resulting run-to-run variance. But it currently has ZERO
// non-test callers — the "separate, env-gated job" described below was never
// built, so nothing measures self-consistency on live traffic and nothing flags
// divergence. The math here is correct and tested; it is simply unwired.
//
// This module is the measurement + gate: feed it the overall scores from N
// repeated grades of one input and it reports the spread and whether it's
// within tolerance.
//
// All functions are PURE and deterministic so the reliability harness can gate
// on fixtures in CI (no live API needed). A separate, env-gated job can sample
// live re-grades and feed their scores here to assert the same invariant against
// production traffic.

// Grades move in 0.5 increments, so two grades of one garment are "consistent"
// when they land within a single increment of each other.
export const SELF_CONSISTENCY_TOLERANCE = 0.5;

export interface SelfConsistencyResult {
  run_count: number;
  mean: number;
  // Population standard deviation of the repeated scores.
  std_dev: number;
  // max(scores) − min(scores): the headline reproducibility number.
  max_spread: number;
  // True when max_spread ≤ tolerance (so re-grades can't disagree by more than
  // one increment). A single run is trivially consistent.
  consistent: boolean;
  tolerance: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Self-consistency of the repeated overall scores for ONE garment.
export function gradeSelfConsistency(
  scores: number[],
  tolerance: number = SELF_CONSISTENCY_TOLERANCE,
): SelfConsistencyResult {
  const n = scores.length;
  if (n === 0) {
    return {
      run_count: 0,
      mean: 0,
      std_dev: 0,
      max_spread: 0,
      consistent: true,
      tolerance,
    };
  }
  const m = mean(scores);
  const variance = mean(scores.map((s) => (s - m) * (s - m)));
  const spread = Math.max(...scores) - Math.min(...scores);
  return {
    run_count: n,
    mean: m,
    std_dev: Math.sqrt(variance),
    max_spread: spread,
    // One run can't disagree with itself.
    consistent: n < 2 ? true : spread <= tolerance + 1e-9,
    tolerance,
  };
}

export interface SelfConsistencyItem {
  item_id: string;
  // The overall scores from repeated grades of this one garment.
  scores: number[];
}

export interface SelfConsistencyReport {
  item_count: number;
  // Items that were graded at least twice — the only ones that inform the gate.
  measured_item_count: number;
  // Fraction of measured items whose re-grades stayed within tolerance.
  consistent_fraction: number;
  // Largest spread seen across any single item — the worst reproducibility case.
  worst_spread: number;
  worst_item_id: string | null;
  // Mean per-item standard deviation across measured items.
  mean_std_dev: number;
  tolerance: number;
  // The CI gate: every measured item must be within tolerance.
  passes: boolean;
}

// Aggregate self-consistency across many repeated-grade fixtures. This is what
// the harness gates on: `passes` is false if ANY garment's re-grades disagree
// by more than one increment.
export function assessSelfConsistency(
  items: SelfConsistencyItem[],
  tolerance: number = SELF_CONSISTENCY_TOLERANCE,
): SelfConsistencyReport {
  const measured = items.filter((it) => it.scores.length >= 2);
  let consistentCount = 0;
  let worstSpread = 0;
  let worstItemId: string | null = null;
  let stdDevSum = 0;

  for (const it of measured) {
    const r = gradeSelfConsistency(it.scores, tolerance);
    if (r.consistent) consistentCount++;
    if (r.max_spread > worstSpread) {
      worstSpread = r.max_spread;
      worstItemId = it.item_id;
    }
    stdDevSum += r.std_dev;
  }

  return {
    item_count: items.length,
    measured_item_count: measured.length,
    consistent_fraction:
      measured.length === 0 ? 1 : consistentCount / measured.length,
    worst_spread: worstSpread,
    worst_item_id: worstItemId,
    mean_std_dev: measured.length === 0 ? 0 : stdDevSum / measured.length,
    tolerance,
    passes: measured.length === 0 ? true : consistentCount === measured.length,
  };
}
