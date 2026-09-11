// US-3323: per-prompt-version AI-vs-human accuracy for /admin/ai-models.
//
// THE DEFECT THIS EXISTS TO END. applyGradeAdjustment (services/edge-functions/
// src/lib/grade-adjustment.ts) writes the reviewer's correction over
// grade_reports.overall_score and the five factor columns. This console read
// `report.overall_score` as "the AI's grade" and compared it with
// `review.adjusted_score ?? review.original_score` — which after an adjustment
// is the same number. So every grade a human corrected scored 0.00 error and
// 100% agreement, the "Accuracy Below Threshold" banner could never fire, and
// the page looked most accurate on exactly the grades it got most wrong.
//
// THE RULE (identical to services/edge-functions/src/lib/review-baseline.ts,
// which every server-side accuracy reader uses; the two are kept in step by
// src/test/admin-review-accuracy-mirror.test.ts):
//
//   AI side    = the EARLIEST review's snapshot. Each review row records the
//                report as it found it (`original_score`, and since migration
//                00784 the five `original_*` factors), so the first row holds
//                the number no human had touched.
//   Human side = the report's CURRENT state, because every review path writes
//                its decision onto the report.
//
// Send-backs ("the photos cannot support a grade") are not a verdict on the AI
// and are excluded; they used to land in the approved-as-is bucket.
//
// One entry per reviewed GRADE, not per review row: two reviews of the same
// garment are one data point, and counting them twice weighted the disputed
// grades double.
//
// Pure: no supabase, no React. Unit-tested in src/test/admin-review-accuracy.test.ts.

export const REVIEW_FACTOR_KEYS = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;

export type ReviewFactorKey = typeof REVIEW_FACTOR_KEYS[number];
export type ReviewFactorScores = Record<ReviewFactorKey, number>;

export interface AccuracyReviewRow {
  grade_report_id: string;
  original_score: number | string;
  adjusted_score: number | string | null;
  reviewed_at?: string | null;
  review_action?: string | null;
  original_fabric_condition?: number | string | null;
  original_structural_integrity?: number | string | null;
  original_cosmetic_appearance?: number | string | null;
  original_functional_elements?: number | string | null;
  original_odor_cleanliness?: number | string | null;
}

export interface AccuracyReportRow {
  id: string;
  model_version?: string | null;
  overall_score: number | string | null;
  fabric_condition_score?: number | string | null;
  structural_integrity_score?: number | string | null;
  cosmetic_appearance_score?: number | string | null;
  functional_elements_score?: number | string | null;
  odor_cleanliness_score?: number | string | null;
}

export interface ReviewedGrade {
  gradeReportId: string;
  /** The overall score before any human touched it. */
  aiOverall: number;
  /** The human-final overall: the report's current score. */
  humanOverall: number;
  /**
   * The AI's five factors, or null when unrecoverable: a pre-00784 grade that
   * a human ADJUSTED lost them when the adjustment overwrote the report. Null
   * means "unknown", never "unchanged".
   */
  aiFactors: ReviewFactorScores | null;
  humanFactors: ReviewFactorScores | null;
  everAdjusted: boolean;
}

export interface FactorAccuracy {
  factor: string;
  mae: number;
  /** mean(human - AI). Positive = the AI graded too harsh, negative = too lenient. */
  meanSignedError: number;
  agreementRate: number;
  /** Grades this factor could actually be measured on. */
  count: number;
}

export interface ReviewAccuracyData {
  versionName: string;
  /** Reviewed GRADES, one per grade report, send-backs excluded. */
  totalReviews: number;
  meanAbsoluteError: number;
  /** mean(human - AI). Positive = the AI graded too harsh. */
  meanSignedError: number;
  agreementRate: number;
  correlation: number;
  factorAccuracies: FactorAccuracy[];
}

export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : num / denom;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function reviewTime(r: AccuracyReviewRow): number {
  const t = r.reviewed_at ? Date.parse(r.reviewed_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/** True for a review that is not a grading verdict at all. */
export function isSendBack(r: AccuracyReviewRow): boolean {
  return r.review_action === "send_back";
}

function snapshotFactors(r: AccuracyReviewRow): ReviewFactorScores | null {
  const out = {} as ReviewFactorScores;
  for (const k of REVIEW_FACTOR_KEYS) {
    const v = num(r[`original_${k}` as keyof AccuracyReviewRow]);
    if (v === null) return null;
    out[k] = v;
  }
  return out;
}

/** The report's five factor columns, or null when any is missing. */
export function reportFactors(
  report: AccuracyReportRow,
): ReviewFactorScores | null {
  const out = {} as ReviewFactorScores;
  for (const k of REVIEW_FACTOR_KEYS) {
    const v = num(report[`${k}_score` as keyof AccuracyReportRow]);
    if (v === null) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Collapse review rows to ONE entry per reviewed grade, carrying the AI's
 * number and the human's number side by side. A review whose report is missing
 * is skipped.
 */
export function buildReviewedGrades(
  reviews: readonly AccuracyReviewRow[],
  reports: ReadonlyMap<string, AccuracyReportRow>,
): ReviewedGrade[] {
  const byReport = new Map<string, AccuracyReviewRow[]>();
  for (const r of reviews) {
    if (!r?.grade_report_id || isSendBack(r)) continue;
    const arr = byReport.get(r.grade_report_id) ?? [];
    arr.push(r);
    byReport.set(r.grade_report_id, arr);
  }

  const out: ReviewedGrade[] = [];
  for (const [reportId, rows] of byReport) {
    const report = reports.get(reportId);
    if (!report) continue;
    // Stable sort: equal timestamps keep input order.
    const sorted = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => reviewTime(a.r) - reviewTime(b.r) || a.i - b.i)
      .map((x) => x.r);
    const earliest = sorted[0]!;
    const latest = sorted[sorted.length - 1]!;

    const aiOverall = num(earliest.original_score);
    const humanOverall = num(report.overall_score) ??
      num(latest.adjusted_score) ?? num(latest.original_score);
    if (aiOverall === null || humanOverall === null) continue;

    const everAdjusted = sorted.some((r) => num(r.adjusted_score) !== null);
    const current = reportFactors(report);
    // Never adjusted means the report still holds exactly what the AI wrote,
    // so it can stand in for a missing snapshot. Once adjusted, it cannot.
    const aiFactors = snapshotFactors(earliest) ?? (everAdjusted ? null : current);

    out.push({
      gradeReportId: reportId,
      aiOverall,
      humanOverall,
      aiFactors,
      humanFactors: current,
      everAdjusted,
    });
  }
  return out;
}

/** human - AI. Positive = the AI graded too harsh; negative = too lenient. */
export function signedOverallError(g: ReviewedGrade): number {
  return g.humanOverall - g.aiOverall;
}

/** Per-factor human - AI, or null for a factor whose AI value is unknown. */
export function signedFactorErrors(
  g: ReviewedGrade,
): Record<ReviewFactorKey, number | null> {
  const out = {} as Record<ReviewFactorKey, number | null>;
  for (const k of REVIEW_FACTOR_KEYS) {
    out[k] = g.aiFactors && g.humanFactors
      ? g.humanFactors[k] - g.aiFactors[k]
      : null;
  }
  return out;
}

function buildFactorAccuracies(grades: ReviewedGrade[]): FactorAccuracy[] {
  return REVIEW_FACTOR_KEYS.map((f) => {
    const signed = grades
      .map((g) => signedFactorErrors(g)[f])
      .filter((v): v is number => v !== null);
    const abs = signed.map((e) => Math.abs(e));
    return {
      factor: f,
      mae: mean(abs),
      meanSignedError: mean(signed),
      agreementRate: abs.length > 0 ? abs.filter((e) => e <= 0.5).length / abs.length : 0,
      count: abs.length,
    };
  });
}

/**
 * Accuracy per model version, one data point per reviewed grade.
 *
 * `reviews` may arrive in any order (the console reads them newest-first) and
 * may contain several rows for one grade; they are collapsed by report id.
 */
export function computeVersionAccuracy(
  reviews: readonly AccuracyReviewRow[],
  reports: ReadonlyMap<string, AccuracyReportRow>,
): ReviewAccuracyData[] {
  if (reviews.length === 0 || reports.size === 0) return [];

  const groups = new Map<string, ReviewedGrade[]>();
  for (const grade of buildReviewedGrades(reviews, reports)) {
    const versionKey = reports.get(grade.gradeReportId)?.model_version || "unknown";
    const arr = groups.get(versionKey) ?? [];
    arr.push(grade);
    groups.set(versionKey, arr);
  }

  const result: ReviewAccuracyData[] = [];
  for (const [versionName, grades] of groups) {
    const signed = grades.map(signedOverallError);
    const abs = signed.map((e) => Math.abs(e));

    result.push({
      versionName,
      totalReviews: grades.length,
      meanAbsoluteError: mean(abs),
      meanSignedError: mean(signed),
      agreementRate: abs.length > 0 ? abs.filter((e) => e <= 0.5).length / abs.length : 0,
      correlation: pearsonCorrelation(
        grades.map((g) => g.aiOverall),
        grades.map((g) => g.humanOverall),
      ),
      factorAccuracies: buildFactorAccuracies(grades),
    });
  }

  return result.sort((a, b) => b.totalReviews - a.totalReviews);
}

/**
 * Which way the AI leans, in words an operator can act on. Under 0.05 points
 * either way is noise on a 0.5-step scale, so it reads as "even".
 *
 * MAE says how far off the AI is; the sign says which way to correct it, and
 * that is the half a prompt change can act on.
 */
export function formatLean(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.05) return "even";
  return v > 0 ? `+${v.toFixed(2)} too harsh` : `${v.toFixed(2)} too lenient`;
}

/**
 * How many reviewed grades the AI got right on its own — grades no reviewer
 * changed. The console used to count `adjusted_score === null` review ROWS,
 * which folded every send-back into the approved-as-is bucket and double-counted
 * a grade reviewed twice.
 */
export function summarizeAgreement(
  reviews: readonly AccuracyReviewRow[],
  reports: ReadonlyMap<string, AccuracyReportRow>,
): { totalReviewed: number; agreedCount: number } {
  const grades = buildReviewedGrades(reviews, reports);
  return {
    totalReviewed: grades.length,
    agreedCount: grades.filter((g) => !g.everAdjusted).length,
  };
}
