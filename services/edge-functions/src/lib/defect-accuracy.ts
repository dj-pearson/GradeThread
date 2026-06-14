// US-1036: per-defect-type accuracy + weight-table calibration.
//
// The general accuracy loop (accuracy-tracking.ts) measures grade-vs-human error
// by prompt version, factor, and garment category — but NOT by defect type or
// size. This module attributes human-review corrections to the defect TYPES and
// SIZES present in each reviewed grade, so we can see which types the AI
// systematically over- or under-penalizes, and recommends adjustments to the
// deterministic defect-weighting table (defect-weighting.ts) accordingly.
//
// All summarize/recommend functions are pure + unit-tested. The async report
// reads the existing defects_found jsonb (no schema change) and joins
// human_reviews → grade_reports exactly like computeAccuracySummary.

import { supabaseAdmin } from "./supabase.ts";
import {
  coerceDefectType,
  coerceSizeBucket,
  DEFECT_WEIGHTS_VERSION,
  type DefectType,
  type SizeBucket,
} from "./defect-weighting.ts";

// One reviewed grade's signed error + the distinct defect types/sizes it carried.
export interface ReviewedGradeDefects {
  // humanFinal − aiOverall: POSITIVE = AI graded lower than the human (too harsh);
  // NEGATIVE = AI graded higher (too lenient).
  signedDelta: number;
  defectTypes: DefectType[];
  sizeBuckets: SizeBucket[];
}

export interface DefectTypeAccuracy {
  defect_type: DefectType;
  /** Reviewed grades containing ≥1 genuine defect of this type. */
  count: number;
  mean_abs_error: number;
  /** + = AI too harsh on grades with this type; − = AI too lenient. */
  mean_signed_delta: number;
  agreement_rate: number;
}

export interface SizeBucketAccuracy {
  size_bucket: SizeBucket;
  count: number;
  mean_abs_error: number;
  mean_signed_delta: number;
  agreement_rate: number;
}

export interface WeightRecommendation {
  defect_type: DefectType;
  direction: "increase" | "decrease";
  mean_signed_delta: number;
  count: number;
  rationale: string;
}

export interface DefectAccuracyReport {
  by_defect_type: DefectTypeAccuracy[];
  by_size_bucket: SizeBucketAccuracy[];
  recommendations: WeightRecommendation[];
  /** The weight-table version these recommendations target. */
  weights_version: string;
  reviewed_grades: number;
  generated_at: string;
}

const AGREE_BAND = 0.5; // overall-score points

// Calibration thresholds — advisory only (never auto-applied to the table).
export const CALIBRATION_MIN_SAMPLES = 8;
export const CALIBRATION_DELTA_THRESHOLD = 0.4;

function aggregate<K extends string>(
  grades: ReviewedGradeDefects[],
  keysOf: (g: ReviewedGradeDefects) => K[],
): Array<{ key: K; count: number; mean_abs_error: number; mean_signed_delta: number; agreement_rate: number }> {
  const buckets = new Map<K, { absSum: number; signedSum: number; agreed: number; count: number }>();
  for (const g of grades) {
    for (const key of new Set(keysOf(g))) {
      const b = buckets.get(key) ?? { absSum: 0, signedSum: 0, agreed: 0, count: 0 };
      b.absSum += Math.abs(g.signedDelta);
      b.signedSum += g.signedDelta;
      if (Math.abs(g.signedDelta) <= AGREE_BAND) b.agreed += 1;
      b.count += 1;
      buckets.set(key, b);
    }
  }
  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      count: b.count,
      mean_abs_error: round2(b.absSum / b.count),
      mean_signed_delta: round2(b.signedSum / b.count),
      agreement_rate: round2(b.agreed / b.count),
    }))
    // Worst (highest MAE) first so over/under-penalized types surface at the top.
    .sort((a, b) => b.mean_abs_error - a.mean_abs_error);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function summarizeByDefectType(grades: ReviewedGradeDefects[]): DefectTypeAccuracy[] {
  return aggregate(grades, (g) => g.defectTypes).map((r) => ({
    defect_type: r.key,
    count: r.count,
    mean_abs_error: r.mean_abs_error,
    mean_signed_delta: r.mean_signed_delta,
    agreement_rate: r.agreement_rate,
  }));
}

export function summarizeBySizeBucket(grades: ReviewedGradeDefects[]): SizeBucketAccuracy[] {
  return aggregate(grades, (g) => g.sizeBuckets).map((r) => ({
    size_bucket: r.key,
    count: r.count,
    mean_abs_error: r.mean_abs_error,
    mean_signed_delta: r.mean_signed_delta,
    agreement_rate: r.agreement_rate,
  }));
}

/**
 * Recommend defect-weight adjustments from per-type signed error. A type whose
 * grades were consistently scored LOWER by the AI than the human (positive mean
 * signed delta beyond the threshold) is over-penalized → DECREASE its weight;
 * consistently HIGHER → under-penalized → INCREASE. Only types with enough
 * samples qualify. Advisory: the operator applies changes to the versioned table.
 */
export function recommendWeightAdjustments(
  byType: DefectTypeAccuracy[],
  opts: { minSamples?: number; deltaThreshold?: number } = {},
): WeightRecommendation[] {
  const minSamples = opts.minSamples ?? CALIBRATION_MIN_SAMPLES;
  const deltaThreshold = opts.deltaThreshold ?? CALIBRATION_DELTA_THRESHOLD;
  const recs: WeightRecommendation[] = [];
  for (const t of byType) {
    if (t.count < minSamples) continue;
    if (Math.abs(t.mean_signed_delta) < deltaThreshold) continue;
    const overPenalized = t.mean_signed_delta > 0; // AI graded lower than human
    recs.push({
      defect_type: t.defect_type,
      direction: overPenalized ? "decrease" : "increase",
      mean_signed_delta: t.mean_signed_delta,
      count: t.count,
      rationale: overPenalized
        ? `AI graded ${t.mean_signed_delta.toFixed(2)} pts LOWER than reviewers on grades with '${t.defect_type}' (n=${t.count}) — likely over-penalized; consider lowering its weight.`
        : `AI graded ${Math.abs(t.mean_signed_delta).toFixed(2)} pts HIGHER than reviewers on grades with '${t.defect_type}' (n=${t.count}) — likely under-penalized; consider raising its weight.`,
    });
  }
  // Strongest signal first.
  return recs.sort((a, b) => Math.abs(b.mean_signed_delta) - Math.abs(a.mean_signed_delta));
}

// Extract the distinct defect types + size buckets from a grade report's
// defects_found jsonb (tolerant of pre-v3 rows lacking the fields).
export function extractGradeDefects(defectsFound: unknown): {
  defectTypes: DefectType[];
  sizeBuckets: SizeBucket[];
} {
  const types = new Set<DefectType>();
  const sizes = new Set<SizeBucket>();
  if (Array.isArray(defectsFound)) {
    for (const d of defectsFound) {
      if (d && typeof d === "object") {
        const raw = d as Record<string, unknown>;
        types.add(coerceDefectType(raw.defect_type));
        sizes.add(coerceSizeBucket(raw.size_bucket));
      }
    }
  }
  return { defectTypes: [...types], sizeBuckets: [...sizes] };
}

/**
 * Build the per-defect-type accuracy + calibration report from human reviews and
 * their grade reports. Mirrors computeAccuracySummary's join; reads defects_found
 * jsonb directly (no schema change). Only grades that have ≥1 genuine defect
 * contribute.
 */
export async function computeDefectAccuracyReport(
  periodStart?: string,
  periodEnd?: string,
): Promise<DefectAccuracyReport> {
  let q = supabaseAdmin
    .from("human_reviews")
    .select("grade_report_id, original_score, adjusted_score");
  if (periodStart) q = q.gte("reviewed_at", periodStart);
  if (periodEnd) q = q.lte("reviewed_at", periodEnd);
  const { data: reviews, error: reviewsError } = await q;
  if (reviewsError) throw new Error(`Failed to fetch reviews: ${reviewsError.message}`);

  const empty: DefectAccuracyReport = {
    by_defect_type: [],
    by_size_bucket: [],
    recommendations: [],
    weights_version: DEFECT_WEIGHTS_VERSION,
    reviewed_grades: 0,
    generated_at: new Date().toISOString(),
  };
  if (!reviews || reviews.length === 0) return empty;

  const reportIds = [...new Set(reviews.map((r) => r.grade_report_id))];
  const { data: reports, error: reportsError } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, defects_found")
    .in("id", reportIds);
  if (reportsError) throw new Error(`Failed to fetch grade reports: ${reportsError.message}`);

  const reportById = new Map(
    (reports ?? []).map((r) => [r.id as string, r as { overall_score: number; defects_found: unknown }]),
  );

  const grades: ReviewedGradeDefects[] = [];
  for (const review of reviews) {
    const report = reportById.get(review.grade_report_id);
    if (!report) continue;
    const { defectTypes, sizeBuckets } = extractGradeDefects(report.defects_found);
    if (defectTypes.length === 0) continue; // only defect-bearing grades inform this
    const humanFinal = review.adjusted_score ?? review.original_score;
    grades.push({
      signedDelta: humanFinal - report.overall_score,
      defectTypes,
      sizeBuckets,
    });
  }

  const byDefectType = summarizeByDefectType(grades);
  return {
    by_defect_type: byDefectType,
    by_size_bucket: summarizeBySizeBucket(grades),
    recommendations: recommendWeightAdjustments(byDefectType),
    weights_version: DEFECT_WEIGHTS_VERSION,
    reviewed_grades: grades.length,
    generated_at: new Date().toISOString(),
  };
}
