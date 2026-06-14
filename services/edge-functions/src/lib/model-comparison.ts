// US-1034: model A/B comparison for the grading eval gate.
//
// Qualify a stronger vision model (e.g. Opus 4.8) against the current default
// (Sonnet 4.6) by running the SAME golden eval cases under each model and
// comparing grade error vs the expert ground truth — sliced by tag — plus a
// per-grade cost delta and a documented promotion rule. The actual run uses
// runEval(..., modelOverride); these functions are pure + unit-tested.
//
// Per-defect-type DETECTION recall/precision (detectionMetrics below) is also
// provided, but computing it requires the golden cases to carry labeled expected
// defect types — a follow-up labeling step (grading_eval_cases has no defect
// labels yet). Until then, the grade-error comparison is the operative signal.

// The slice of an eval run this comparison needs (subset of EvalRunResult).
export interface ModelEvalRun {
  model: string;
  mean_absolute_error: number;
  agreement_rate: number;
  cases_total: number;
  cases_passed: number;
  per_tag: Record<string, { mean_absolute_error: number; agreement_rate: number; count: number }>;
  /** Mean output-token cost per grade in USD, if known (for the cost delta). */
  cost_per_grade_usd?: number | null;
}

export interface TagDelta {
  tag: string;
  mae_delta: number; // b − a (negative = B better)
  agreement_delta: number; // b − a (positive = B better)
  count: number;
}

export interface ModelComparison {
  model_a: string;
  model_b: string;
  mae_delta: number; // b − a (negative = B has lower error = better)
  agreement_delta: number; // b − a (positive = B agrees more = better)
  cost_delta_usd_per_grade: number | null; // b − a
  per_tag: TagDelta[];
  regressed_tags: string[]; // tags where B is materially worse
  recommend_promote_b: boolean;
  rationale: string;
}

// Promotion thresholds (documented, conservative). B must improve overall error
// meaningfully AND not regress any well-sampled tag beyond tolerance.
export const PROMOTE_MIN_MAE_GAIN = 0.1; // B must cut MAE by ≥ this
export const PROMOTE_MAX_AGREEMENT_DROP = 0.0; // B must not agree less overall
export const TAG_REGRESSION_MAE_TOLERANCE = 0.3; // per-tag MAE worsening that counts as a regression
export const TAG_REGRESSION_MIN_COUNT = 5; // only well-sampled tags gate promotion

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Compare two model eval runs over the same cases. B is recommended for
 * promotion only if it lowers overall MAE by at least PROMOTE_MIN_MAE_GAIN,
 * doesn't drop overall agreement, and doesn't materially regress any
 * well-sampled tag. The decision is advisory — the operator flips the config.
 */
export function compareModelEvals(
  a: ModelEvalRun,
  b: ModelEvalRun,
  opts: {
    minMaeGain?: number;
    maxAgreementDrop?: number;
    tagRegressionTolerance?: number;
    tagRegressionMinCount?: number;
  } = {},
): ModelComparison {
  const minMaeGain = opts.minMaeGain ?? PROMOTE_MIN_MAE_GAIN;
  const maxAgreementDrop = opts.maxAgreementDrop ?? PROMOTE_MAX_AGREEMENT_DROP;
  const tagTol = opts.tagRegressionTolerance ?? TAG_REGRESSION_MAE_TOLERANCE;
  const tagMinCount = opts.tagRegressionMinCount ?? TAG_REGRESSION_MIN_COUNT;

  const maeDelta = round3(b.mean_absolute_error - a.mean_absolute_error);
  const agreementDelta = round3(b.agreement_rate - a.agreement_rate);

  const tags = new Set([...Object.keys(a.per_tag), ...Object.keys(b.per_tag)]);
  const perTag: TagDelta[] = [];
  const regressed: string[] = [];
  for (const tag of tags) {
    const ta = a.per_tag[tag];
    const tb = b.per_tag[tag];
    if (!ta || !tb) continue; // only tags present in both runs are comparable
    const maeD = round3(tb.mean_absolute_error - ta.mean_absolute_error);
    const agrD = round3(tb.agreement_rate - ta.agreement_rate);
    const count = Math.min(ta.count, tb.count);
    perTag.push({ tag, mae_delta: maeD, agreement_delta: agrD, count });
    if (count >= tagMinCount && maeD > tagTol) regressed.push(tag);
  }
  perTag.sort((x, y) => x.mae_delta - y.mae_delta); // biggest B-improvement first

  const costDelta =
    a.cost_per_grade_usd != null && b.cost_per_grade_usd != null
      ? round3(b.cost_per_grade_usd - a.cost_per_grade_usd)
      : null;

  const improvesMae = -maeDelta >= minMaeGain; // maeDelta negative = improvement
  const keepsAgreement = agreementDelta >= -maxAgreementDrop;
  const noRegression = regressed.length === 0;
  const promote = improvesMae && keepsAgreement && noRegression;

  const reasons: string[] = [];
  reasons.push(
    improvesMae
      ? `${b.model} cuts MAE by ${(-maeDelta).toFixed(3)} (≥ ${minMaeGain})`
      : `${b.model} does not cut MAE by the required ${minMaeGain} (delta ${maeDelta.toFixed(3)})`,
  );
  if (!keepsAgreement) reasons.push(`agreement drops ${(-agreementDelta).toFixed(3)}`);
  if (!noRegression) reasons.push(`regresses tags: ${regressed.join(", ")}`);
  if (costDelta != null) {
    reasons.push(`cost/grade delta ${costDelta >= 0 ? "+" : ""}$${costDelta.toFixed(3)}`);
  }

  return {
    model_a: a.model,
    model_b: b.model,
    mae_delta: maeDelta,
    agreement_delta: agreementDelta,
    cost_delta_usd_per_grade: costDelta,
    per_tag: perTag,
    regressed_tags: regressed,
    recommend_promote_b: promote,
    rationale: (promote ? "PROMOTE: " : "HOLD: ") + reasons.join("; ") + ".",
  };
}

// ── Per-defect-type detection metrics (ready for a labeled golden set) ──

export interface DetectionCase {
  /** Distinct expected defect types for this case (expert ground truth). */
  expected: string[];
  /** Distinct defect types the model predicted for this case. */
  predicted: string[];
}

export interface DetectionMetric {
  defect_type: string;
  true_positive: number;
  false_positive: number;
  false_negative: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Per-defect-type precision/recall/F1 across labeled cases. Pure; usable for any
 * label dimension (defect type or size bucket) once the golden set carries
 * expected labels.
 */
export function detectionMetrics(cases: DetectionCase[]): DetectionMetric[] {
  const tp = new Map<string, number>();
  const fp = new Map<string, number>();
  const fn = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const c of cases) {
    const exp = new Set(c.expected);
    const pred = new Set(c.predicted);
    for (const p of pred) (exp.has(p) ? bump(tp, p) : bump(fp, p));
    for (const e of exp) if (!pred.has(e)) bump(fn, e);
  }

  const labels = new Set<string>([...tp.keys(), ...fp.keys(), ...fn.keys()]);
  const out: DetectionMetric[] = [];
  for (const label of labels) {
    const t = tp.get(label) ?? 0;
    const f = fp.get(label) ?? 0;
    const n = fn.get(label) ?? 0;
    const precision = t + f === 0 ? 0 : t / (t + f);
    const recall = t + n === 0 ? 0 : t / (t + n);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    out.push({
      defect_type: label,
      true_positive: t,
      false_positive: f,
      false_negative: n,
      precision: round3(precision),
      recall: round3(recall),
      f1: round3(f1),
    });
  }
  return out.sort((a, b) => a.recall - b.recall); // worst recall first (what we miss)
}
