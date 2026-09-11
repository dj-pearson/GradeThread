// US-3323: what the AI said, and what the human decided, for one reviewed grade.
//
// THE DEFECT THIS EXISTS TO END. An adjustment (lib/grade-adjustment.ts)
// overwrites grade_reports.overall_score and the five factor columns with the
// reviewer's correction. Every accuracy reader then took the report's CURRENT
// score as "the AI's grade" and compared it with the reviewer's score, which is
// the same number. So every corrected grade read as zero error:
//
//   • the accuracy dashboard and the public transparency figures,
//   • the confidence-calibration miner, which would have concluded the AI is
//     never wrong and LOWERED the review threshold,
//   • the defect-type bias report and the few-shot exemplar miner,
//   • the training export, which paired the human's score with itself.
//
// The grades a human corrected are the only ones that carry a lesson, and they
// were exactly the ones erased.
//
// THE RULE, in one place so the readers cannot drift apart again:
//
//   AI side    = the EARLIEST review's snapshot. Each review row records the
//                score it found before it acted (`original_score`, and since
//                00784 the five `original_*` factors), so the first row holds
//                the number no human had touched yet.
//   Human side = the report's CURRENT state. Every review path writes its
//                decision onto the report (approve leaves it, adjust and dispute
//                overwrite it), so the report is the latest human answer.
//
// Send-backs are excluded outright. "The photos cannot support a grade" is not
// "the AI was right", and before 00784 it was counted as an approval.
//
// Pure: no supabase, no env. Unit-tested in review-baseline_test.ts.

export const REVIEW_FACTOR_KEYS = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;

export type ReviewFactorKey = typeof REVIEW_FACTOR_KEYS[number];
export type ReviewFactorScores = Record<ReviewFactorKey, number>;

/** The human_reviews columns this module reads. Select at least these. */
export const REVIEW_BASELINE_COLUMNS =
  "grade_report_id, original_score, adjusted_score, reviewed_at, review_action, " +
  "original_fabric_condition, original_structural_integrity, original_cosmetic_appearance, " +
  "original_functional_elements, original_odor_cleanliness";

/** The grade_reports factor columns, which hold the CURRENT (human-final) factors. */
export const REPORT_FACTOR_COLUMNS =
  "fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, " +
  "functional_elements_score, odor_cleanliness_score";

export interface ReviewBaselineRow {
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

export interface ReportForBaseline {
  overall_score: number | string | null;
  fabric_condition_score?: number | string | null;
  structural_integrity_score?: number | string | null;
  cosmetic_appearance_score?: number | string | null;
  functional_elements_score?: number | string | null;
  odor_cleanliness_score?: number | string | null;
}

export interface ReviewedGrade<R extends ReviewBaselineRow = ReviewBaselineRow> {
  gradeReportId: string;
  /** The overall score before any human touched it. */
  aiOverall: number;
  /** The human-final overall: the report's current score. */
  humanOverall: number;
  /**
   * The AI's five factors, or null when they are unrecoverable: a pre-00784
   * grade that a human ADJUSTED lost them when the adjustment overwrote the
   * report. Null means "unknown", never "unchanged".
   */
  aiFactors: ReviewFactorScores | null;
  /** The human-final factors: the report's current columns. */
  humanFactors: ReviewFactorScores | null;
  /** True when any review on this grade changed its score. */
  everAdjusted: boolean;
  /** The newest review row, for readers that need its flags or timestamp. */
  latest: R;
  /** The oldest review row. */
  earliest: R;
  /** Review rows counted for this grade (send-backs excluded). */
  reviewCount: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function reviewTime(r: ReviewBaselineRow): number {
  const t = r.reviewed_at ? Date.parse(r.reviewed_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** True for a review that is not a grading verdict at all. */
export function isSendBack(r: ReviewBaselineRow): boolean {
  return r.review_action === "send_back";
}

function snapshotFactors(r: ReviewBaselineRow): ReviewFactorScores | null {
  const out = {} as ReviewFactorScores;
  for (const k of REVIEW_FACTOR_KEYS) {
    const v = num(r[`original_${k}` as keyof ReviewBaselineRow]);
    if (v === null) return null;
    out[k] = v;
  }
  return out;
}

/** The report's five factor columns, or null when any is missing. */
export function reportFactors(
  report: ReportForBaseline,
): ReviewFactorScores | null {
  const out = {} as ReviewFactorScores;
  for (const k of REVIEW_FACTOR_KEYS) {
    const v = num(report[`${k}_score` as keyof ReportForBaseline]);
    if (v === null) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Collapse review rows to ONE entry per reviewed grade, carrying the AI's
 * number and the human's number side by side.
 *
 * `reports` maps grade_report_id to the report's current row. A review whose
 * report is missing is skipped, as every reader did before.
 */
export function buildReviewedGrades<R extends ReviewBaselineRow>(
  reviews: readonly R[],
  reports: ReadonlyMap<string, ReportForBaseline>,
): ReviewedGrade<R>[] {
  const byReport = new Map<string, R[]>();
  for (const r of reviews) {
    if (!r?.grade_report_id || isSendBack(r)) continue;
    const arr = byReport.get(r.grade_report_id) ?? [];
    arr.push(r);
    byReport.set(r.grade_report_id, arr);
  }

  const out: ReviewedGrade<R>[] = [];
  for (const [reportId, rows] of byReport) {
    const report = reports.get(reportId);
    if (!report) continue;
    // Stable sort: equal timestamps keep input order.
    const sorted = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => reviewTime(a.r) - reviewTime(b.r) || a.i - b.i)
      .map((x) => x.r);
    const earliest = sorted[0];
    const latest = sorted[sorted.length - 1];

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
      latest,
      earliest,
      reviewCount: sorted.length,
    });
  }
  return out;
}

/** human − AI. POSITIVE = the AI graded too harsh; NEGATIVE = too lenient. */
export function signedOverallError(g: ReviewedGrade): number {
  return g.humanOverall - g.aiOverall;
}

/** Per-factor human − AI, or null for a factor whose AI value is unknown. */
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

/** The snapshot a review path must write: the report as it stood before acting. */
export function reviewSnapshot(
  report: ReportForBaseline,
): Record<`original_${ReviewFactorKey}`, number | null> {
  const out = {} as Record<`original_${ReviewFactorKey}`, number | null>;
  for (const k of REVIEW_FACTOR_KEYS) {
    out[`original_${k}`] = num(report[`${k}_score` as keyof ReportForBaseline]);
  }
  return out;
}

// ── US-3325: the flaws-only grade against the same human answer ─────────────

/** One grade_flaws_only row, as read. Factors keyed like the report columns. */
export interface FlawsOnlyRow {
  grade_report_id: string;
  overall: number | string;
  factors: Record<string, number | string | null> | null;
}

export interface FlawsOnlyFactorStat {
  factor: ReviewFactorKey;
  count: number;
  ai_mean_absolute_error: number;
  flaws_only_mean_absolute_error: number;
  /** mean(human − flaws-only). + = the flaw math alone grades too harsh. */
  flaws_only_mean_signed_error: number;
}

export interface FlawsOnlyCategoryStat {
  garment_category: string;
  count: number;
  ai_mean_absolute_error: number;
  flaws_only_mean_absolute_error: number;
}

export interface FlawsOnlyComparison {
  /** Reviewed grades that carry a flaws-only row. */
  compared: number;
  /** Reviewed grades with none (graded before 00785, or its write failed). */
  excluded: number;
  /** AI error over the SAME compared set, so the two numbers are comparable. */
  ai_mean_absolute_error: number;
  ai_mean_signed_error: number;
  flaws_only_mean_absolute_error: number;
  flaws_only_mean_signed_error: number;
  factors: FlawsOnlyFactorStat[];
  categories: FlawsOnlyCategoryStat[];
}

function avg(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/**
 * Compare the AI's grade and the flaws-only grade against the same human-final
 * answer, over exactly the grades that have both. Pure.
 */
export function compareFlawsOnly(
  graded: ReadonlyArray<{ grade: ReviewedGrade; category: string }>,
  flawsByReport: ReadonlyMap<string, FlawsOnlyRow>,
): FlawsOnlyComparison {
  const both = graded
    .map((g) => ({ ...g, flaws: flawsByReport.get(g.grade.gradeReportId) }))
    .filter((g): g is typeof g & { flaws: FlawsOnlyRow } =>
      g.flaws !== undefined && num(g.flaws.overall) !== null
    );

  const aiSigned = both.map((g) => signedOverallError(g.grade));
  const foSigned = both.map((g) => g.grade.humanOverall - num(g.flaws.overall)!);

  const factors: FlawsOnlyFactorStat[] = REVIEW_FACTOR_KEYS.map((k) => {
    const ai: number[] = [];
    const fo: number[] = [];
    for (const g of both) {
      const human = g.grade.humanFactors?.[k];
      const aiF = g.grade.aiFactors?.[k];
      const foF = num(g.flaws.factors?.[`${k}_score`]);
      // Only grades where all three sides of this factor are known.
      if (human === undefined || aiF === undefined || foF === null) continue;
      ai.push(human - aiF);
      fo.push(human - foF);
    }
    return {
      factor: k,
      count: fo.length,
      ai_mean_absolute_error: avg(ai.map(Math.abs)),
      flaws_only_mean_absolute_error: avg(fo.map(Math.abs)),
      flaws_only_mean_signed_error: avg(fo),
    };
  });

  const byCat = new Map<string, { ai: number[]; fo: number[] }>();
  both.forEach((g, i) => {
    const e = byCat.get(g.category) ?? { ai: [], fo: [] };
    e.ai.push(Math.abs(aiSigned[i]));
    e.fo.push(Math.abs(foSigned[i]));
    byCat.set(g.category, e);
  });
  const categories = [...byCat.entries()]
    .map(([garment_category, e]) => ({
      garment_category,
      count: e.fo.length,
      ai_mean_absolute_error: avg(e.ai),
      flaws_only_mean_absolute_error: avg(e.fo),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    compared: both.length,
    excluded: graded.length - both.length,
    ai_mean_absolute_error: avg(aiSigned.map(Math.abs)),
    ai_mean_signed_error: avg(aiSigned),
    flaws_only_mean_absolute_error: avg(foSigned.map(Math.abs)),
    flaws_only_mean_signed_error: avg(foSigned),
    factors,
    categories,
  };
}
