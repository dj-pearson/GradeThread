// Garment Passport — condition-over-time curve (US-1282).
//
// PURE, dependency-free (no supabase, no env) so it unit-tests directly. Given a
// garment's FINALIZED grade history (read from the PII-free public_grade_reports
// view — never the base table, US-1282 AC4), assemble the chronological
// condition curve: each grade carries the overall score + the five per-factor
// condition scores, plus the per-factor DELTA from the prior grade. Two grades
// on one garment produce a 2-point curve whose second point's deltas equal
// (this − prior) for every factor (AC5).
//
// The factor keys mirror public_grade_reports' per-factor columns 1:1 (which
// mirror grade_reports + the 5-factor rubric: Fabric / Structural / Cosmetic /
// Functional / Odor-Cleanliness). Deltas are rounded to one decimal so the
// half-point grade scale never surfaces float noise (8.0 − 6.5 = 1.5, not
// 1.4999…). The first point has null deltas (no prior); a delta is null whenever
// either side's score is missing (a partial/legacy grade).

/** The five condition factors, in rubric order. label drives the public UI. */
export const CONDITION_FACTORS = [
  { key: "fabric_condition_score", label: "Fabric" },
  { key: "structural_integrity_score", label: "Structural" },
  { key: "cosmetic_appearance_score", label: "Cosmetic" },
  { key: "functional_elements_score", label: "Functional" },
  { key: "odor_cleanliness_score", label: "Odor & Cleanliness" },
] as const;

export type ConditionFactorKey = typeof CONDITION_FACTORS[number]["key"];

/** A public-safe grade row as projected by public_grade_reports (no PII). */
export interface PublicGradePoint {
  certificate_id: string | null;
  created_at: string;
  overall_score: number | null;
  grade_tier: string | null;
  confidence_label?: string | null;
  fabric_condition_score: number | null;
  structural_integrity_score: number | null;
  cosmetic_appearance_score: number | null;
  functional_elements_score: number | null;
  odor_cleanliness_score: number | null;
}

/** One point on the rendered condition-over-time curve. */
export interface ConditionCurvePoint {
  /** Public certificate handle for this grade (links to /cert/:id). */
  certificate: string | null;
  graded_at: string;
  overall: number | null;
  grade_tier: string | null;
  confidence_label: string | null;
  factors: Record<ConditionFactorKey, number | null>;
  /** Overall delta vs the previous point (null for the first / a missing side). */
  overall_delta: number | null;
  /** Per-factor delta vs the previous point (null first / on a missing side). */
  factor_deltas: Record<ConditionFactorKey, number | null>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Round to one decimal, killing float artifacts on the half-point scale. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Delta = current − prior, rounded; null when either side is missing. */
function delta(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  return round1(current - prior);
}

/**
 * Build the chronological condition curve for a garment from its finalized
 * public grade rows. Sorted oldest→newest by created_at (stable for equal
 * timestamps). Each point's deltas compare against the immediately prior point.
 */
export function buildConditionCurve(reports: PublicGradePoint[]): ConditionCurvePoint[] {
  const sorted = [...reports].sort((a, b) => {
    const ta = Date.parse(a.created_at);
    const tb = Date.parse(b.created_at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return 0; // stable: preserve input order on ties / unparseable dates
  });

  const points: ConditionCurvePoint[] = [];
  let prev: ConditionCurvePoint | null = null;

  for (const r of sorted) {
    const factors = {} as Record<ConditionFactorKey, number | null>;
    const factorDeltas = {} as Record<ConditionFactorKey, number | null>;
    for (const f of CONDITION_FACTORS) {
      const score = num(r[f.key]);
      factors[f.key] = score;
      factorDeltas[f.key] = delta(score, prev ? prev.factors[f.key] : null);
    }
    const overall = num(r.overall_score);
    const point: ConditionCurvePoint = {
      certificate: r.certificate_id,
      graded_at: r.created_at,
      overall,
      grade_tier: r.grade_tier,
      confidence_label: r.confidence_label ?? null,
      factors,
      overall_delta: delta(overall, prev ? prev.overall : null),
      factor_deltas: factorDeltas,
    };
    points.push(point);
    prev = point;
  }

  return points;
}
