import { supabaseAdmin } from "./supabase.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface FactorAccuracy {
  factor: string;
  mean_absolute_error: number;
  agreement_rate: number; // % within 0.5 points
  count: number;
}

export interface PromptVersionAccuracy {
  prompt_version_id: string;
  version_name: string;
  overall_mean_absolute_error: number;
  overall_agreement_rate: number; // % within 0.5 points
  correlation_coefficient: number;
  factor_accuracies: FactorAccuracy[];
  total_reviews: number;
  period_start: string | null;
  period_end: string | null;
}

export interface AccuracySummary {
  versions: PromptVersionAccuracy[];
  global_mean_absolute_error: number;
  global_agreement_rate: number;
  total_reviews: number;
  generated_at: string;
}

export interface TrainingDataEntry {
  review_id: string;
  grade_report_id: string;
  submission_id: string;
  garment_type: string;
  garment_category: string;
  ai_overall_score: number;
  ai_grade_tier: string;
  ai_fabric_condition: number;
  ai_structural_integrity: number;
  ai_cosmetic_appearance: number;
  ai_functional_elements: number;
  ai_odor_cleanliness: number;
  ai_confidence: number;
  ai_summary: string;
  human_original_score: number;
  human_adjusted_score: number | null;
  human_review_notes: string | null;
  reviewed_at: string;
  model_version: string;
}

// ─── Factor score extraction ────────────────────────────────────────

const FACTOR_NAMES = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;

// Factor weights used for weighted accuracy computation
// (exported for potential future use in prompt evaluation)
export const FACTOR_WEIGHTS: Record<string, number> = {
  fabric_condition: 0.3,
  structural_integrity: 0.25,
  cosmetic_appearance: 0.2,
  functional_elements: 0.15,
  odor_cleanliness: 0.1,
};

// ─── Core accuracy calculation ──────────────────────────────────────

/**
 * Calculate accuracy metrics for a human review compared to the AI grade.
 * Called after each human review to compute per-factor |AI_score - human_score|.
 */
export function calculateReviewAccuracy(
  aiScores: {
    overall_score: number;
    fabric_condition_score: number;
    structural_integrity_score: number;
    cosmetic_appearance_score: number;
    functional_elements_score: number;
    odor_cleanliness_score: number;
  },
  humanOriginalScore: number,
  humanAdjustedScore: number | null
): {
  overall_error: number;
  factor_errors: Record<string, number>;
  agreed: boolean;
} {
  // If adjusted_score is null, human approved as-is (perfect agreement)
  const humanFinalScore = humanAdjustedScore ?? humanOriginalScore;
  const overallError = Math.abs(aiScores.overall_score - humanFinalScore);
  const agreed = overallError <= 0.5;

  // Per-factor errors: when human adjusts, we compute per-factor difference
  // using weighted scaling. Since human reviews only provide an overall adjusted
  // score (not per-factor), we estimate per-factor error from overall error ratio.
  const aiOverall = aiScores.overall_score;
  const errorRatio = aiOverall !== 0 ? (humanFinalScore - aiOverall) / aiOverall : 0;

  const factorErrors: Record<string, number> = {};
  const factorScores: Record<string, number> = {
    fabric_condition: aiScores.fabric_condition_score,
    structural_integrity: aiScores.structural_integrity_score,
    cosmetic_appearance: aiScores.cosmetic_appearance_score,
    functional_elements: aiScores.functional_elements_score,
    odor_cleanliness: aiScores.odor_cleanliness_score,
  };

  for (const factor of FACTOR_NAMES) {
    if (humanAdjustedScore === null) {
      // Approved as-is: zero error per factor
      factorErrors[factor] = 0;
    } else {
      // Estimate per-factor error from overall error ratio
      factorErrors[factor] = Math.abs(factorScores[factor] * errorRatio);
    }
  }

  return { overall_error: overallError, factor_errors: factorErrors, agreed };
}

/**
 * Compute Pearson correlation coefficient between two arrays.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;
  return numerator / denom;
}

// ─── Aggregate accuracy metrics ─────────────────────────────────────

/**
 * Compute aggregate accuracy metrics per prompt version.
 * Uses human reviews + grade reports to calculate MAE, agreement rate,
 * and correlation coefficient.
 */
export async function computeAccuracySummary(
  periodStart?: string,
  periodEnd?: string
): Promise<AccuracySummary> {
  // Fetch human reviews with their associated grade reports
  let reviewsQuery = supabaseAdmin
    .from("human_reviews")
    .select("*");

  if (periodStart) {
    reviewsQuery = reviewsQuery.gte("reviewed_at", periodStart);
  }
  if (periodEnd) {
    reviewsQuery = reviewsQuery.lte("reviewed_at", periodEnd);
  }

  const { data: reviews, error: reviewsError } = await reviewsQuery;
  if (reviewsError) throw new Error(`Failed to fetch reviews: ${reviewsError.message}`);

  if (!reviews || reviews.length === 0) {
    return {
      versions: [],
      global_mean_absolute_error: 0,
      global_agreement_rate: 0,
      total_reviews: 0,
      generated_at: new Date().toISOString(),
    };
  }

  // Fetch all grade reports that have been reviewed
  const gradeReportIds = [...new Set(reviews.map((r) => r.grade_report_id))];
  const { data: gradeReports, error: reportsError } = await supabaseAdmin
    .from("grade_reports")
    .select("*")
    .in("id", gradeReportIds);

  if (reportsError) throw new Error(`Failed to fetch grade reports: ${reportsError.message}`);

  // Fetch prompt versions for grouping
  const { data: promptVersions, error: versionsError } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("*");

  if (versionsError) throw new Error(`Failed to fetch prompt versions: ${versionsError.message}`);

  // Build grade report lookup
  const reportMap = new Map<string, typeof gradeReports extends (infer R)[] ? R : never>();
  for (const report of gradeReports ?? []) {
    reportMap.set(report.id, report);
  }

  // Build prompt version lookup
  const versionMap = new Map<string, { id: string; version_name: string }>();
  for (const v of promptVersions ?? []) {
    versionMap.set(v.version_name, { id: v.id, version_name: v.version_name });
    // Also map by ID for fallback
    versionMap.set(v.id, { id: v.id, version_name: v.version_name });
  }

  // Group reviews by prompt version (via grade_report.model_version)
  type VersionGroup = {
    reviews: Array<{
      review: typeof reviews[0];
      report: NonNullable<ReturnType<typeof reportMap.get>>;
    }>;
  };

  const versionGroups = new Map<string, VersionGroup>();
  const globalErrors: number[] = [];
  let globalAgreed = 0;
  const globalAiScores: number[] = [];
  const globalHumanScores: number[] = [];

  for (const review of reviews) {
    const report = reportMap.get(review.grade_report_id);
    if (!report) continue;

    const modelVersion = report.model_version || "unknown";
    const versionKey = modelVersion;

    if (!versionGroups.has(versionKey)) {
      versionGroups.set(versionKey, { reviews: [] });
    }
    versionGroups.get(versionKey)!.reviews.push({ review, report });

    // Global metrics
    const humanFinal = review.adjusted_score ?? review.original_score;
    const error = Math.abs(report.overall_score - humanFinal);
    globalErrors.push(error);
    if (error <= 0.5) globalAgreed++;
    globalAiScores.push(report.overall_score);
    globalHumanScores.push(humanFinal);
  }

  // Compute per-version metrics
  const versionAccuracies: PromptVersionAccuracy[] = [];

  for (const [versionKey, group] of versionGroups) {
    const versionInfo = versionMap.get(versionKey);
    const aiScores: number[] = [];
    const humanScores: number[] = [];
    const errors: number[] = [];
    let agreed = 0;

    const factorErrors: Record<string, number[]> = {};
    for (const f of FACTOR_NAMES) {
      factorErrors[f] = [];
    }

    for (const { review, report } of group.reviews) {
      const humanFinal = review.adjusted_score ?? review.original_score;
      const error = Math.abs(report.overall_score - humanFinal);
      errors.push(error);
      if (error <= 0.5) agreed++;
      aiScores.push(report.overall_score);
      humanScores.push(humanFinal);

      // Per-factor accuracy
      const reviewAccuracy = calculateReviewAccuracy(
        {
          overall_score: report.overall_score,
          fabric_condition_score: report.fabric_condition_score,
          structural_integrity_score: report.structural_integrity_score,
          cosmetic_appearance_score: report.cosmetic_appearance_score,
          functional_elements_score: report.functional_elements_score,
          odor_cleanliness_score: report.odor_cleanliness_score,
        },
        review.original_score,
        review.adjusted_score
      );

      for (const f of FACTOR_NAMES) {
        factorErrors[f].push(reviewAccuracy.factor_errors[f]);
      }
    }

    const mae = errors.reduce((s, e) => s + e, 0) / errors.length;
    const agreementRate = agreed / errors.length;
    const correlation = pearsonCorrelation(aiScores, humanScores);

    const factorAccuracies: FactorAccuracy[] = FACTOR_NAMES.map((f) => ({
      factor: f,
      mean_absolute_error:
        factorErrors[f].length > 0
          ? factorErrors[f].reduce((s, e) => s + e, 0) / factorErrors[f].length
          : 0,
      agreement_rate:
        factorErrors[f].length > 0
          ? factorErrors[f].filter((e) => e <= 0.5).length / factorErrors[f].length
          : 0,
      count: factorErrors[f].length,
    }));

    // Determine period
    const dates = group.reviews.map((r) => r.review.reviewed_at);
    dates.sort();

    versionAccuracies.push({
      prompt_version_id: versionInfo?.id ?? versionKey,
      version_name: versionInfo?.version_name ?? versionKey,
      overall_mean_absolute_error: mae,
      overall_agreement_rate: agreementRate,
      correlation_coefficient: correlation,
      factor_accuracies: factorAccuracies,
      total_reviews: group.reviews.length,
      period_start: dates[0] ?? null,
      period_end: dates[dates.length - 1] ?? null,
    });
  }

  const globalMae =
    globalErrors.length > 0
      ? globalErrors.reduce((s, e) => s + e, 0) / globalErrors.length
      : 0;
  const globalAgreementRate =
    globalErrors.length > 0 ? globalAgreed / globalErrors.length : 0;

  return {
    versions: versionAccuracies,
    global_mean_absolute_error: globalMae,
    global_agreement_rate: globalAgreementRate,
    total_reviews: reviews.length,
    generated_at: new Date().toISOString(),
  };
}

// ─── Update prompt version accuracy score ───────────────────────────

/**
 * After a human review, update the accuracy_score on the related prompt version.
 * Called as fire-and-forget after review creation.
 */
export async function updatePromptVersionAccuracy(
  gradeReportId: string
): Promise<void> {
  try {
    // Get the grade report to find the model_version
    const { data: report, error: reportError } = await supabaseAdmin
      .from("grade_reports")
      .select("model_version")
      .eq("id", gradeReportId)
      .single();

    if (reportError || !report) {
      console.error("[AccuracyTracking] Failed to fetch grade report:", reportError);
      return;
    }

    const modelVersion = report.model_version;

    // Find the prompt version by version name
    const { data: version, error: versionError } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("id, version_name")
      .eq("version_name", modelVersion)
      .single();

    if (versionError || !version) {
      // No matching prompt version found — skip silently
      console.log(
        `[AccuracyTracking] No prompt version found for model_version="${modelVersion}"`
      );
      return;
    }

    // Compute accuracy for this version from all its reviews
    const summary = await computeAccuracySummary();
    const versionAccuracy = summary.versions.find(
      (v) => v.version_name === modelVersion
    );

    if (versionAccuracy) {
      const accuracyScore = versionAccuracy.overall_agreement_rate;
      await supabaseAdmin
        .from("ai_prompt_versions")
        .update({
          accuracy_score: accuracyScore,
          total_grades: versionAccuracy.total_reviews,
        })
        .eq("id", version.id);

      console.log(
        `[AccuracyTracking] Updated ${modelVersion} accuracy=${(accuracyScore * 100).toFixed(1)}% ` +
          `(${versionAccuracy.total_reviews} reviews)`
      );
    }
  } catch (err) {
    console.error(
      "[AccuracyTracking] Failed to update prompt version accuracy:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ─── Export training dataset ────────────────────────────────────────

/**
 * Export all human-reviewed grades as JSONL training dataset.
 * Each line is a JSON object with AI analysis + human adjustments.
 */
export async function exportTrainingDataset(): Promise<string> {
  // Fetch all reviews
  const { data: reviews, error: reviewsError } = await supabaseAdmin
    .from("human_reviews")
    .select("*")
    .order("reviewed_at", { ascending: true });

  if (reviewsError) throw new Error(`Failed to fetch reviews: ${reviewsError.message}`);
  if (!reviews || reviews.length === 0) return "";

  // Fetch all associated grade reports
  const gradeReportIds = [...new Set(reviews.map((r) => r.grade_report_id))];
  const { data: gradeReports, error: reportsError } = await supabaseAdmin
    .from("grade_reports")
    .select("*")
    .in("id", gradeReportIds);

  if (reportsError) throw new Error(`Failed to fetch grade reports: ${reportsError.message}`);

  const reportMap = new Map<string, (typeof gradeReports)[number]>();
  for (const report of gradeReports ?? []) {
    reportMap.set(report.id, report);
  }

  // Fetch submissions for garment info
  const submissionIds = [...new Set((gradeReports ?? []).map((r) => r.submission_id))];
  const { data: submissions, error: subsError } = await supabaseAdmin
    .from("submissions")
    .select("id, garment_type, garment_category")
    .in("id", submissionIds);

  if (subsError) throw new Error(`Failed to fetch submissions: ${subsError.message}`);

  const submissionMap = new Map<string, (typeof submissions)[number]>();
  for (const sub of submissions ?? []) {
    submissionMap.set(sub.id, sub);
  }

  // Build JSONL output
  const lines: string[] = [];

  for (const review of reviews) {
    const report = reportMap.get(review.grade_report_id);
    if (!report) continue;

    const submission = submissionMap.get(report.submission_id);

    const entry: TrainingDataEntry = {
      review_id: review.id,
      grade_report_id: review.grade_report_id,
      submission_id: report.submission_id,
      garment_type: submission?.garment_type ?? "unknown",
      garment_category: submission?.garment_category ?? "unknown",
      ai_overall_score: report.overall_score,
      ai_grade_tier: report.grade_tier,
      ai_fabric_condition: report.fabric_condition_score,
      ai_structural_integrity: report.structural_integrity_score,
      ai_cosmetic_appearance: report.cosmetic_appearance_score,
      ai_functional_elements: report.functional_elements_score,
      ai_odor_cleanliness: report.odor_cleanliness_score,
      ai_confidence: report.confidence_score,
      ai_summary: report.ai_summary,
      human_original_score: review.original_score,
      human_adjusted_score: review.adjusted_score,
      human_review_notes: review.review_notes,
      reviewed_at: review.reviewed_at,
      model_version: report.model_version,
    };

    lines.push(JSON.stringify(entry));
  }

  return lines.join("\n");
}

// ─── Weekly accuracy summary ────────────────────────────────────────

/**
 * Compute a weekly accuracy summary for the last 7 days.
 * Can be called on-demand or scheduled.
 */
export async function computeWeeklyAccuracySummary(): Promise<AccuracySummary> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return computeAccuracySummary(
    weekAgo.toISOString(),
    now.toISOString()
  );
}
