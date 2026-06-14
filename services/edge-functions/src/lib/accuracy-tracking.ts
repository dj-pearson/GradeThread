import { supabaseAdmin } from "./supabase.ts";
import { evalThresholds } from "./grading-eval.ts";
import { reviewConfidenceThreshold } from "./ai-config.ts";
import { computeIrrReport, type ItemRatings } from "./irr.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface FactorAccuracy {
  factor: string;
  mean_absolute_error: number;
  agreement_rate: number; // % within 0.5 points
  count: number;
}

export interface CategoryAccuracy {
  garment_category: string;
  mean_absolute_error: number;
  agreement_rate: number;
  intentional_misread_rate: number; // share of reviews flagged as design-misread
  count: number;
}

export interface PromptVersionAccuracy {
  prompt_version_id: string;
  version_name: string;
  overall_mean_absolute_error: number;
  overall_agreement_rate: number; // % within 0.5 points
  correlation_coefficient: number;
  intentional_misread_rate: number;
  factor_accuracies: FactorAccuracy[];
  category_accuracies: CategoryAccuracy[];
  total_reviews: number;
  period_start: string | null;
  period_end: string | null;
}

export interface AccuracySummary {
  versions: PromptVersionAccuracy[];
  global_mean_absolute_error: number;
  global_agreement_rate: number;
  global_intentional_misread_rate: number;
  // Accuracy sliced by garment_category across all versions — this is where
  // "jeans MAE is 3x average" surfaces.
  category_accuracies: CategoryAccuracy[];
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
  ai_detected_style_attributes: unknown;
  human_original_score: number;
  human_adjusted_score: number | null;
  human_review_notes: string | null;
  // The denim-regression signal: reviewer said the AI mistook intentional
  // design for damage. These rows are the highest-value few-shot exemplars.
  human_intentional_misread: boolean;
  reviewed_at: string;
  model_version: string;
  prompt_version: string | null;
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

// The human-review fields the accuracy math needs. Reviewers may correct the
// overall score and/or individual factors; null means "not changed".
export interface ReviewCorrection {
  original_score: number;
  adjusted_score: number | null;
  adjusted_fabric_condition: number | null;
  adjusted_structural_integrity: number | null;
  adjusted_cosmetic_appearance: number | null;
  adjusted_functional_elements: number | null;
  adjusted_odor_cleanliness: number | null;
}

const FACTOR_TO_REPORT_KEY: Record<string, string> = {
  fabric_condition: "fabric_condition_score",
  structural_integrity: "structural_integrity_score",
  cosmetic_appearance: "cosmetic_appearance_score",
  functional_elements: "functional_elements_score",
  odor_cleanliness: "odor_cleanliness_score",
};

const FACTOR_TO_ADJUSTED_KEY: Record<string, keyof ReviewCorrection> = {
  fabric_condition: "adjusted_fabric_condition",
  structural_integrity: "adjusted_structural_integrity",
  cosmetic_appearance: "adjusted_cosmetic_appearance",
  functional_elements: "adjusted_functional_elements",
  odor_cleanliness: "adjusted_odor_cleanliness",
};

/**
 * Calculate accuracy metrics for a human review compared to the AI grade.
 *
 * Per-factor error now uses the reviewer's ACTUAL per-factor correction when
 * present (so we can attribute bias to a specific factor, e.g. Fabric on
 * denim). A factor with no correction returns null — excluded from MAE rather
 * than fabricated from the overall ratio. When the reviewer approved as-is
 * (adjusted_score null and no factor edits), every factor error is 0.
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
  review: ReviewCorrection
): {
  overall_error: number;
  factor_errors: Record<string, number | null>;
  agreed: boolean;
} {
  const humanFinalScore = review.adjusted_score ?? review.original_score;
  const overallError = Math.abs(aiScores.overall_score - humanFinalScore);
  const agreed = overallError <= 0.5;

  const anyFactorEdited = FACTOR_NAMES.some(
    (f) => review[FACTOR_TO_ADJUSTED_KEY[f]] !== null
  );
  const approvedAsIs = review.adjusted_score === null && !anyFactorEdited;

  const aiScoreMap = aiScores as unknown as Record<string, number>;
  const factorErrors: Record<string, number | null> = {};

  for (const factor of FACTOR_NAMES) {
    if (approvedAsIs) {
      factorErrors[factor] = 0;
      continue;
    }
    const adjusted = review[FACTOR_TO_ADJUSTED_KEY[factor]] as number | null;
    if (adjusted === null || adjusted === undefined) {
      // No explicit correction for this factor — unknown, don't guess.
      factorErrors[factor] = null;
    } else {
      const aiFactor = aiScoreMap[FACTOR_TO_REPORT_KEY[factor]];
      factorErrors[factor] = Math.abs(aiFactor - adjusted);
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

// Resolve the prompt-version key for a grade report. Prefers the first-class
// prompt_version column; falls back to parsing the legacy "model|prompt"
// model_version string so historical rows still group sensibly.
function promptVersionKey(report: {
  prompt_version?: string | null;
  model_version?: string | null;
}): string {
  if (report.prompt_version && report.prompt_version.trim().length > 0) {
    return report.prompt_version;
  }
  const mv = report.model_version || "";
  if (mv.includes("|")) return mv.split("|")[1] || "unknown";
  return mv || "unknown";
}

// Mean over the non-null entries (null = "reviewer didn't touch this factor").
function meanNonNull(values: (number | null)[]): { mean: number; count: number } {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return { mean: 0, count: 0 };
  return { mean: present.reduce((s, v) => s + v, 0) / present.length, count: present.length };
}

interface ReviewReportPair {
  review: ReviewCorrection & { intentional_misread?: boolean };
  report: {
    overall_score: number;
    fabric_condition_score: number;
    structural_integrity_score: number;
    cosmetic_appearance_score: number;
    functional_elements_score: number;
    odor_cleanliness_score: number;
  };
  category: string;
}

// Build a CategoryAccuracy from a set of review/report pairs sharing a category.
function buildCategoryAccuracy(category: string, pairs: ReviewReportPair[]): CategoryAccuracy {
  let errSum = 0;
  let agreed = 0;
  let misread = 0;
  for (const { review, report } of pairs) {
    const humanFinal = review.adjusted_score ?? review.original_score;
    const err = Math.abs(report.overall_score - humanFinal);
    errSum += err;
    if (err <= 0.5) agreed++;
    if (review.intentional_misread) misread++;
  }
  return {
    garment_category: category,
    mean_absolute_error: errSum / pairs.length,
    agreement_rate: agreed / pairs.length,
    intentional_misread_rate: misread / pairs.length,
    count: pairs.length,
  };
}

/**
 * Compute aggregate accuracy metrics per prompt version.
 * Uses human reviews + grade reports to calculate MAE, agreement rate,
 * correlation, per-factor MAE (from real reviewer corrections), per-category
 * accuracy, and the intentional-misread rate (the denim-regression signal).
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

  const emptySummary: AccuracySummary = {
    versions: [],
    global_mean_absolute_error: 0,
    global_agreement_rate: 0,
    global_intentional_misread_rate: 0,
    category_accuracies: [],
    total_reviews: 0,
    generated_at: new Date().toISOString(),
  };

  if (!reviews || reviews.length === 0) {
    return emptySummary;
  }

  // Fetch all grade reports that have been reviewed
  const gradeReportIds = [...new Set(reviews.map((r) => r.grade_report_id))];
  const { data: gradeReports, error: reportsError } = await supabaseAdmin
    .from("grade_reports")
    .select("*")
    .in("id", gradeReportIds);

  if (reportsError) throw new Error(`Failed to fetch grade reports: ${reportsError.message}`);

  // Fetch the submissions behind those reports to slice accuracy by category.
  const submissionIds = [...new Set((gradeReports ?? []).map((r) => r.submission_id))];
  const { data: submissions, error: subsError } = await supabaseAdmin
    .from("submissions")
    .select("id, garment_category")
    .in("id", submissionIds);
  if (subsError) throw new Error(`Failed to fetch submissions: ${subsError.message}`);
  const categoryBySubmission = new Map<string, string>();
  for (const s of submissions ?? []) {
    categoryBySubmission.set(s.id, s.garment_category ?? "unknown");
  }

  // Fetch prompt versions for grouping/id resolution
  const { data: promptVersions, error: versionsError } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, version_name");

  if (versionsError) throw new Error(`Failed to fetch prompt versions: ${versionsError.message}`);

  // Build grade report lookup
  type Report = NonNullable<typeof gradeReports>[number];
  const reportMap = new Map<string, Report>();
  for (const report of gradeReports ?? []) {
    reportMap.set(report.id, report);
  }

  // version_name → id (used to attribute accuracy back to a prompt version row)
  const versionIdByName = new Map<string, string>();
  for (const v of promptVersions ?? []) {
    versionIdByName.set(v.version_name, v.id);
  }

  type VersionGroup = { pairs: ReviewReportPair[]; dates: string[] };
  const versionGroups = new Map<string, VersionGroup>();
  const allPairs: ReviewReportPair[] = [];

  for (const review of reviews) {
    const report = reportMap.get(review.grade_report_id);
    if (!report) continue;

    const category = categoryBySubmission.get(report.submission_id) ?? "unknown";
    const pair: ReviewReportPair = { review, report, category };
    allPairs.push(pair);

    const versionKey = promptVersionKey(report);
    if (!versionGroups.has(versionKey)) {
      versionGroups.set(versionKey, { pairs: [], dates: [] });
    }
    const g = versionGroups.get(versionKey)!;
    g.pairs.push(pair);
    g.dates.push(review.reviewed_at);
  }

  // Per-version metrics
  const versionAccuracies: PromptVersionAccuracy[] = [];

  for (const [versionKey, group] of versionGroups) {
    const aiScores: number[] = [];
    const humanScores: number[] = [];
    const errors: number[] = [];
    let agreed = 0;
    let misread = 0;

    const factorErrors: Record<string, (number | null)[]> = {};
    for (const f of FACTOR_NAMES) factorErrors[f] = [];

    for (const { review, report } of group.pairs) {
      const humanFinal = review.adjusted_score ?? review.original_score;
      const error = Math.abs(report.overall_score - humanFinal);
      errors.push(error);
      if (error <= 0.5) agreed++;
      if (review.intentional_misread) misread++;
      aiScores.push(report.overall_score);
      humanScores.push(humanFinal);

      const reviewAccuracy = calculateReviewAccuracy(
        {
          overall_score: report.overall_score,
          fabric_condition_score: report.fabric_condition_score,
          structural_integrity_score: report.structural_integrity_score,
          cosmetic_appearance_score: report.cosmetic_appearance_score,
          functional_elements_score: report.functional_elements_score,
          odor_cleanliness_score: report.odor_cleanliness_score,
        },
        review
      );
      for (const f of FACTOR_NAMES) factorErrors[f].push(reviewAccuracy.factor_errors[f]);
    }

    const mae = errors.reduce((s, e) => s + e, 0) / errors.length;
    const agreementRate = agreed / errors.length;
    const correlation = pearsonCorrelation(aiScores, humanScores);

    const factorAccuracies: FactorAccuracy[] = FACTOR_NAMES.map((f) => {
      const present = factorErrors[f].filter((v): v is number => v !== null);
      const { mean } = meanNonNull(factorErrors[f]);
      return {
        factor: f,
        mean_absolute_error: mean,
        agreement_rate:
          present.length > 0 ? present.filter((e) => e <= 0.5).length / present.length : 0,
        count: present.length,
      };
    });

    // Per-category breakdown within this version
    const byCategory = new Map<string, ReviewReportPair[]>();
    for (const p of group.pairs) {
      const arr = byCategory.get(p.category) ?? [];
      arr.push(p);
      byCategory.set(p.category, arr);
    }
    const categoryAccuracies = [...byCategory.entries()]
      .map(([cat, pairs]) => buildCategoryAccuracy(cat, pairs))
      .sort((a, b) => b.mean_absolute_error - a.mean_absolute_error);

    const dates = [...group.dates].sort();

    versionAccuracies.push({
      prompt_version_id: versionIdByName.get(versionKey) ?? versionKey,
      version_name: versionKey,
      overall_mean_absolute_error: mae,
      overall_agreement_rate: agreementRate,
      correlation_coefficient: correlation,
      intentional_misread_rate: misread / group.pairs.length,
      factor_accuracies: factorAccuracies,
      category_accuracies: categoryAccuracies,
      total_reviews: group.pairs.length,
      period_start: dates[0] ?? null,
      period_end: dates[dates.length - 1] ?? null,
    });
  }

  // Global metrics + global per-category breakdown
  const globalErrors = allPairs.map(({ review, report }) =>
    Math.abs(report.overall_score - (review.adjusted_score ?? review.original_score))
  );
  const globalMae =
    globalErrors.length > 0 ? globalErrors.reduce((s, e) => s + e, 0) / globalErrors.length : 0;
  const globalAgreementRate =
    globalErrors.length > 0
      ? globalErrors.filter((e) => e <= 0.5).length / globalErrors.length
      : 0;
  const globalMisread =
    allPairs.length > 0
      ? allPairs.filter((p) => p.review.intentional_misread).length / allPairs.length
      : 0;

  const globalByCategory = new Map<string, ReviewReportPair[]>();
  for (const p of allPairs) {
    const arr = globalByCategory.get(p.category) ?? [];
    arr.push(p);
    globalByCategory.set(p.category, arr);
  }
  const categoryAccuracies = [...globalByCategory.entries()]
    .map(([cat, pairs]) => buildCategoryAccuracy(cat, pairs))
    .sort((a, b) => b.mean_absolute_error - a.mean_absolute_error);

  return {
    versions: versionAccuracies,
    global_mean_absolute_error: globalMae,
    global_agreement_rate: globalAgreementRate,
    global_intentional_misread_rate: globalMisread,
    category_accuracies: categoryAccuracies,
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
    // Get the grade report to find the prompt version. Prefer the first-class
    // prompt_version column; fall back to parsing the legacy model_version.
    const { data: report, error: reportError } = await supabaseAdmin
      .from("grade_reports")
      .select("model_version, prompt_version")
      .eq("id", gradeReportId)
      .single();

    if (reportError || !report) {
      console.error("[AccuracyTracking] Failed to fetch grade report:", reportError);
      return;
    }

    const versionName = promptVersionKey(report);

    // Find the prompt version row by version name (now an actual match because
    // we group/store on prompt_version, not the combined "model|prompt" string).
    const { data: version, error: versionError } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("id, version_name")
      .eq("version_name", versionName)
      .maybeSingle();

    if (versionError || !version) {
      console.log(
        `[AccuracyTracking] No prompt version row for version_name="${versionName}"`
      );
      return;
    }

    // Compute accuracy for this version from all its reviews
    const summary = await computeAccuracySummary();
    const versionAccuracy = summary.versions.find(
      (v) => v.version_name === versionName
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
        `[AccuracyTracking] Updated ${versionName} accuracy=${(accuracyScore * 100).toFixed(1)}% ` +
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
      ai_detected_style_attributes: report.detected_style_attributes ?? [],
      human_original_score: review.original_score,
      human_adjusted_score: review.adjusted_score,
      human_review_notes: review.review_notes,
      human_intentional_misread: review.intentional_misread === true,
      reviewed_at: review.reviewed_at,
      model_version: report.model_version,
      prompt_version: report.prompt_version ?? null,
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

  return await computeAccuracySummary(
    weekAgo.toISOString(),
    now.toISOString()
  );
}

// ─── Public transparency report (US-326) ───────────────────────────
//
// A SAFE, aggregate-only view of grading quality for the public
// /transparency page. NO per-user, per-item, or per-tenant data leaves this
// function — only platform-wide counts and rates. This is what substantiates
// the "leading, trustworthy grading authority" claim with published receipts
// instead of marketing copy.
//
// Honesty rule (matches the brand): when there isn't enough data to state a
// metric truthfully, the field is null and the page says "not enough data yet"
// rather than printing a misleading 0%.

// Below this many reviewed/sold items we don't publish a rate — too small to
// be meaningful, and a single outlier would distort it.
const PUBLIC_MIN_SAMPLE = 10;
// Cap the rows scanned for the cheap confidence/review-rate aggregate. At
// launch scale this is every row; it bounds cost as volume grows. The figure
// is described as "recent grades" on the page so the cap is truthful.
const PUBLIC_CONFIDENCE_SCAN_CAP = 10_000;

export interface PublicTransparencyReport {
  generated_at: string;
  scale: { min: number; max: number; increment: number; tiers: number };
  volume: {
    items_graded: number;
    human_reviews: number;
    graded_sales: number;
  };
  quality: {
    // AI grade vs. human reviewer, share within 0.5 points.
    human_agreement_rate: number | null;
    mean_absolute_error: number | null;
    // Share of reviews where a reviewer flagged the AI mistaking intentional
    // design (e.g. factory distressing) for damage. Lower is better.
    intentional_misread_rate: number | null;
    // Mean model confidence across recent grades.
    avg_confidence: number | null;
    // Share of grades auto-routed to a human before finalizing.
    human_review_rate: number | null;
  };
  outcomes: {
    // Share of graded, opted-in sales that drew a buyer condition dispute.
    dispute_rate: number | null;
  };
  // US-866: per-garment-category accuracy/MAE breakdown — where "jeans MAE is 3x
  // tees" surfaces publicly. Aggregate-only and sample-gated: a category appears
  // only when it has >= PUBLIC_MIN_SAMPLE reviewed grades behind it (so no thinly
  // sampled category prints a misleading rate). Empty until a category clears the
  // bar; "unknown" is never published.
  category_quality: Array<{
    garment_category: string;
    mean_absolute_error: number;
    agreement_rate: number;
    reviews: number;
  }>;
  // The published activation gate every model version must clear before it can
  // grade live traffic. Static facts — always safe to publish.
  gate: { max_mae: number; min_agreement: number };
  model: {
    active: Array<{ stage: string; version_name: string }>;
  };
  // Recent model versions that cleared the eval gate — a public changelog of
  // the platform getting measurably better over time.
  changelog: Array<{
    version_name: string;
    model: string;
    mean_absolute_error: number;
    agreement_rate: number;
    passed: boolean;
    created_at: string;
  }>;
  // US-334: human-vs-human reliability baseline from the most recent closed
  // study with a sufficient sample, and how the AI compares against it. null
  // until such a study exists — never publish a baseline below the sample bar.
  reliability: {
    study_name: string;
    pairable_items: number;
    tolerance: number;
    human_agreement_rate: number;
    human_mae: number;
    krippendorff_alpha: number | null;
    ai_agreement_rate: number | null;
    ai_meets_human: boolean | null;
  } | null;
}

// US-334/US-866: load the human-vs-human baseline + AI comparison from the most
// recent CLOSED reliability study an admin has explicitly PUBLISHED to
// transparency (US-866) AND that meets the citable-sample bar. Returns null when
// none qualifies (so the public report shows a clean "baseline pending" state
// rather than a study the team hasn't vetted). Aggregate-only; safe to publish.
async function loadCitableReliability(): Promise<
  PublicTransparencyReport["reliability"]
> {
  const { data: studies } = await supabaseAdmin
    .from("reliability_studies")
    .select("id, name, tolerance")
    .eq("status", "closed")
    .eq("published_to_transparency", true)
    .order("created_at", { ascending: false })
    .limit(10);

  for (const study of studies ?? []) {
    const { data: itemRows } = await supabaseAdmin
      .from("reliability_study_items")
      .select("submission_id")
      .eq("study_id", study.id);
    const submissionIds = (itemRows ?? []).map((r) => r.submission_id);
    if (submissionIds.length === 0) continue;

    const { data: ratingRows } = await supabaseAdmin
      .from("reliability_ratings")
      .select("submission_id, overall_score")
      .eq("study_id", study.id);

    const byItem = new Map<string, number[]>();
    for (const id of submissionIds) byItem.set(id, []);
    for (const r of ratingRows ?? []) {
      byItem.get(r.submission_id)?.push(Number(r.overall_score));
    }
    const items: ItemRatings[] = [...byItem.entries()].map((
      [item_id, scores],
    ) => ({ item_id, scores }));

    const aiScores = new Map<string, number>();
    const { data: reports } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id, overall_score")
      .in("submission_id", submissionIds);
    for (const r of reports ?? []) {
      aiScores.set(r.submission_id, Number(r.overall_score));
    }

    const report = computeIrrReport(items, aiScores, Number(study.tolerance));
    if (!report.sufficient_sample) continue;

    return {
      study_name: String(study.name),
      pairable_items: report.pairable_item_count,
      tolerance: Number(study.tolerance),
      human_agreement_rate: report.human.agreement_within,
      human_mae: report.human.mae,
      krippendorff_alpha: report.krippendorff_alpha,
      ai_agreement_rate: report.ai_vs_human?.ai_agreement_within ?? null,
      ai_meets_human: report.ai_vs_human?.ai_meets_human ?? null,
    };
  }
  return null;
}

// Publish a rate only when there's a meaningful sample behind it; otherwise
// null so the page says "not enough data yet" instead of a misleading number.
function publishedRate(rate: number, sample: number): number | null {
  return sample >= PUBLIC_MIN_SAMPLE ? rate : null;
}

// US-866: project the internal per-category accuracy onto a public-safe, sample-
// gated breakdown. Pure + exported for unit testing. Drops the catch-all
// "unknown" bucket and any category below PUBLIC_MIN_SAMPLE so the public page
// never prints a rate a single outlier could swing. Worst categories first.
export function publicCategoryQuality(
  categories: CategoryAccuracy[],
): PublicTransparencyReport["category_quality"] {
  return categories
    .filter((c) => c.garment_category !== "unknown" && c.count >= PUBLIC_MIN_SAMPLE)
    .map((c) => ({
      garment_category: c.garment_category,
      mean_absolute_error: c.mean_absolute_error,
      agreement_rate: c.agreement_rate,
      reviews: c.count,
    }))
    .sort((a, b) => b.mean_absolute_error - a.mean_absolute_error);
}

/**
 * Build the public transparency report. Aggregate-only and safe to expose
 * unauthenticated. Callers should cache it (it scans reviews/outcomes) — see
 * routes/public-grading.ts.
 */
export async function computePublicTransparency(): Promise<PublicTransparencyReport> {
  // Exact total graded (cheap head count).
  const { count: itemsGradedRaw } = await supabaseAdmin
    .from("grade_reports")
    .select("id", { count: "exact", head: true });
  const itemsGraded = itemsGradedRaw ?? 0;

  // Recent confidence + auto-review rate over a bounded window.
  const { data: recentReports } = await supabaseAdmin
    .from("grade_reports")
    .select("confidence_score, needs_human_review")
    .order("created_at", { ascending: false })
    .limit(PUBLIC_CONFIDENCE_SCAN_CAP);
  let avgConfidence: number | null = null;
  let humanReviewRate: number | null = null;
  if (recentReports && recentReports.length > 0) {
    const confs = recentReports
      .map((r) => Number(r.confidence_score))
      .filter((n) => Number.isFinite(n));
    if (confs.length > 0) {
      avgConfidence = confs.reduce((s, v) => s + v, 0) / confs.length;
    }
    const flagged = recentReports.filter((r) => r.needs_human_review === true).length;
    humanReviewRate = recentReports.length > 0 ? flagged / recentReports.length : null;
  }

  // Human-review accuracy + post-sale outcomes (reuse the existing engines).
  const [accuracy, outcomes] = await Promise.all([
    computeAccuracySummary(),
    computeOutcomeFeedback(),
  ]);

  const humanReviews = accuracy.total_reviews;
  const gradedSales = outcomes.total_graded_sales;

  // Active model versions (safe to name — they're version labels, not prompts).
  const { data: activeVersions } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("stage, version_name")
    .eq("is_active", true);

  // Public changelog: recent passing eval runs, newest first.
  const { data: runs } = await supabaseAdmin
    .from("grading_eval_runs")
    .select("prompt_version_name, model, mean_absolute_error, agreement_rate, passed, created_at")
    .eq("passed", true)
    .order("created_at", { ascending: false })
    .limit(8);

  return {
    generated_at: new Date().toISOString(),
    scale: { min: 1, max: 10, increment: 0.5, tiers: 7 },
    volume: {
      items_graded: itemsGraded,
      human_reviews: humanReviews,
      graded_sales: gradedSales,
    },
    quality: {
      human_agreement_rate: publishedRate(accuracy.global_agreement_rate, humanReviews),
      mean_absolute_error: publishedRate(accuracy.global_mean_absolute_error, humanReviews),
      intentional_misread_rate: publishedRate(
        accuracy.global_intentional_misread_rate,
        humanReviews,
      ),
      avg_confidence: avgConfidence,
      human_review_rate: humanReviewRate,
    },
    outcomes: {
      dispute_rate: publishedRate(outcomes.overall_dispute_rate, gradedSales),
    },
    category_quality: publicCategoryQuality(accuracy.category_accuracies),
    gate: evalThresholds(),
    model: {
      active: (activeVersions ?? []).map((v) => ({
        stage: String(v.stage),
        version_name: String(v.version_name),
      })),
    },
    changelog: (runs ?? []).map((r) => ({
      version_name: String(r.prompt_version_name),
      model: String(r.model),
      mean_absolute_error: Number(r.mean_absolute_error),
      agreement_rate: Number(r.agreement_rate),
      passed: r.passed === true,
      created_at: String(r.created_at),
    })),
    reliability: await loadCitableReliability(),
  };
}

// ─── Public stat counters (US-865) ─────────────────────────────────
//
// A slim, aggregate-only set of headline numbers for the homepage + marketing
// "social proof" counters. Same safety contract as computePublicTransparency:
// only platform-wide counts and a published agreement rate leave this function —
// no per-user, per-item, or per-tenant data. Kept separate from (and cheaper
// than) the full transparency report so the homepage isn't carrying the
// changelog/reliability/calibration weight just to show four numbers.

export interface PublicStats {
  generated_at: string;
  // Exact platform-wide grade count.
  items_graded: number;
  // Opt-in verified-seller profiles (same projection as the public directory).
  verified_sellers: number;
  // Tracked graded sales (opt-in sale-outcome feedback rows).
  graded_sales: number;
  // Mean AI-vs-human agreement (share within 0.5 pts). null until a citable
  // sample exists — the frontend then omits the counter rather than show a
  // misleading figure.
  agreement_rate: number | null;
}

/**
 * Compute the public stat counters. Aggregate-only and safe to expose
 * unauthenticated. Callers should cache it aggressively (these move slowly) —
 * see routes/public-grading.ts.
 */
export async function computePublicStats(): Promise<PublicStats> {
  const [graded, sellers, sales, accuracy] = await Promise.all([
    // Cheap exact head counts.
    supabaseAdmin.from("grade_reports").select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("verified_enabled", true)
      .not("verified_handle", "is", null),
    supabaseAdmin.from("grade_outcomes").select("id", { count: "exact", head: true }),
    // The agreement rate reuses the existing accuracy engine (sample-gated).
    computeAccuracySummary(),
  ]);

  return {
    generated_at: new Date().toISOString(),
    items_graded: graded.count ?? 0,
    verified_sellers: sellers.count ?? 0,
    graded_sales: sales.count ?? 0,
    agreement_rate: publishedRate(accuracy.global_agreement_rate, accuracy.total_reviews),
  };
}

// ─── Confidence calibration (US-331) ────────────────────────────────
//
// Is the model's confidence score actually predictive of grading error? We
// bucket reviewed grades by confidence and report observed agreement/MAE per
// bucket (a reliability curve), then recommend the lowest confidence threshold
// at which the grades the AI ships unreviewed still clear a target agreement.
// This makes "confidence" a calibrated, defensible signal instead of a number.

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  mean_confidence: number;
  agreement_rate: number; // within 0.5 of the human grade
  mean_absolute_error: number;
}

export interface CalibrationReport {
  bins: CalibrationBin[];
  total: number;
  current_threshold: number;
  // Lowest confidence at which grades >= it meet the target agreement with a
  // meaningful sample; null if no threshold reaches the target yet.
  recommended_threshold: number | null;
  // Agreement actually observed among grades AT/ABOVE the current threshold —
  // i.e. how trustworthy the grades we currently SHIP unreviewed really are.
  agreement_at_current: number | null;
  target_agreement: number;
  generated_at: string;
}

const CALIBRATION_MIN_SUBSET = 10;

/**
 * Pure reliability-curve builder. Exported + unit-tested. `pairs` are
 * {confidence, error} from reviewed grades; error is |ai - human| (<=0.5 means
 * agreed). Recommends the lowest bin edge T where the grades with confidence>=T
 * (and a meaningful sample) reach targetAgreement.
 */
export function buildCalibration(
  pairs: Array<{ confidence: number; error: number }>,
  currentThreshold: number,
  targetAgreement = 0.9,
  binCount = 10,
): Omit<CalibrationReport, "generated_at"> {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < binCount; b++) {
    const lo = b / binCount;
    const hi = (b + 1) / binCount;
    const inBin = pairs.filter((p) =>
      b === binCount - 1
        ? p.confidence >= lo && p.confidence <= hi
        : p.confidence >= lo && p.confidence < hi,
    );
    const count = inBin.length;
    const agreed = inBin.filter((p) => p.error <= 0.5).length;
    bins.push({
      lo,
      hi,
      count,
      mean_confidence: count > 0 ? inBin.reduce((s, p) => s + p.confidence, 0) / count : 0,
      agreement_rate: count > 0 ? agreed / count : 0,
      mean_absolute_error: count > 0 ? inBin.reduce((s, p) => s + p.error, 0) / count : 0,
    });
  }

  // Agreement among grades at/above a threshold.
  const agreementAtOrAbove = (t: number): number | null => {
    const subset = pairs.filter((p) => p.confidence >= t);
    if (subset.length < CALIBRATION_MIN_SUBSET) return null;
    return subset.filter((p) => p.error <= 0.5).length / subset.length;
  };

  let recommended: number | null = null;
  for (let b = 0; b < binCount; b++) {
    const t = b / binCount;
    const ar = agreementAtOrAbove(t);
    if (ar !== null && ar >= targetAgreement) {
      recommended = Number(t.toFixed(2));
      break;
    }
  }

  return {
    bins,
    total: pairs.length,
    current_threshold: currentThreshold,
    recommended_threshold: recommended,
    agreement_at_current: agreementAtOrAbove(currentThreshold),
    target_agreement: targetAgreement,
  };
}

/**
 * Compute the confidence calibration report from reviewed grades. The error is
 * |ai overall - human final| per reviewed grade; confidence is the grade's
 * stored confidence_score.
 */
export async function computeConfidenceCalibration(): Promise<CalibrationReport> {
  const generated_at = new Date().toISOString();
  const threshold = reviewConfidenceThreshold();

  const { data: reviews, error: reviewsError } = await supabaseAdmin
    .from("human_reviews")
    .select("grade_report_id, original_score, adjusted_score");
  if (reviewsError) throw new Error(`Failed to fetch reviews: ${reviewsError.message}`);
  if (!reviews || reviews.length === 0) {
    return { ...buildCalibration([], threshold), generated_at };
  }

  const reportIds = [...new Set(reviews.map((r) => r.grade_report_id))];
  const { data: reports, error: reportsError } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, confidence_score")
    .in("id", reportIds);
  if (reportsError) throw new Error(`Failed to fetch grade reports: ${reportsError.message}`);

  const reportById = new Map<string, { overall_score: number; confidence_score: number }>();
  for (const r of reports ?? []) {
    reportById.set(r.id, {
      overall_score: Number(r.overall_score),
      confidence_score: Number(r.confidence_score),
    });
  }

  const pairs: Array<{ confidence: number; error: number }> = [];
  for (const review of reviews) {
    const report = reportById.get(review.grade_report_id);
    if (!report || !Number.isFinite(report.confidence_score)) continue;
    const humanFinal = review.adjusted_score ?? review.original_score;
    pairs.push({
      confidence: report.confidence_score,
      error: Math.abs(report.overall_score - humanFinal),
    });
  }

  return { ...buildCalibration(pairs, threshold), generated_at };
}

// ─── Sale-outcome feedback (closes the grade_outcomes loop) ─────────

export interface CategoryOutcomeSignal {
  garment_category: string;
  graded_sales: number;
  dispute_count: number;
  dispute_rate: number;
  // Mean ratio of sold price to listing price — a proxy for whether the grade
  // helped the item sell at ask. <1 with high disputes on a category is a
  // signal the grades there may run high.
  mean_sold_to_listing_ratio: number | null;
  // Correlation between grade and sold price within the category. Weak/negative
  // correlation suggests the grade isn't tracking real-world value.
  grade_price_correlation: number | null;
}

export interface OutcomeFeedbackSummary {
  categories: CategoryOutcomeSignal[];
  total_graded_sales: number;
  overall_dispute_rate: number;
  generated_at: string;
}

/**
 * Consume grade_outcomes (opt-in sale + dispute feedback, migration 00036) to
 * surface where grades may be drifting from real-world value. This is the
 * other half of the self-improvement loop: human reviews catch grading errors
 * pre-sale; this catches them post-sale (disputes, weak grade↔price coupling)
 * sliced by garment_category so denim/distressed issues stand out.
 */
export async function computeOutcomeFeedback(): Promise<OutcomeFeedbackSummary> {
  const { data: outcomes, error } = await supabaseAdmin
    .from("grade_outcomes")
    .select("grade_report_id, listing_price, sold_price, dispute_reported");
  if (error) throw new Error(`Failed to fetch grade outcomes: ${error.message}`);

  const empty: OutcomeFeedbackSummary = {
    categories: [],
    total_graded_sales: 0,
    overall_dispute_rate: 0,
    generated_at: new Date().toISOString(),
  };
  if (!outcomes || outcomes.length === 0) return empty;

  // Resolve grade + category for each outcome via grade_reports → submissions.
  const reportIds = [...new Set(outcomes.map((o) => o.grade_report_id))];
  const { data: reports } = await supabaseAdmin
    .from("grade_reports")
    .select("id, overall_score, submission_id")
    .in("id", reportIds);
  const reportById = new Map<string, { overall_score: number; submission_id: string }>();
  for (const r of reports ?? []) {
    reportById.set(r.id, { overall_score: r.overall_score, submission_id: r.submission_id });
  }
  const submissionIds = [...new Set((reports ?? []).map((r) => r.submission_id))];
  const { data: subs } = await supabaseAdmin
    .from("submissions")
    .select("id, garment_category")
    .in("id", submissionIds);
  const categoryBySubmission = new Map<string, string>();
  for (const s of subs ?? []) categoryBySubmission.set(s.id, s.garment_category ?? "unknown");

  type Acc = {
    grades: number[];
    soldPrices: number[];
    ratios: number[];
    disputes: number;
    sales: number;
  };
  const byCategory = new Map<string, Acc>();
  let totalSales = 0;
  let totalDisputes = 0;

  for (const o of outcomes) {
    const report = reportById.get(o.grade_report_id);
    if (!report) continue;
    const category = categoryBySubmission.get(report.submission_id) ?? "unknown";
    const acc =
      byCategory.get(category) ??
      { grades: [], soldPrices: [], ratios: [], disputes: 0, sales: 0 };
    acc.sales++;
    totalSales++;
    if (o.dispute_reported) {
      acc.disputes++;
      totalDisputes++;
    }
    if (typeof o.sold_price === "number") {
      acc.grades.push(report.overall_score);
      acc.soldPrices.push(o.sold_price);
      if (typeof o.listing_price === "number" && o.listing_price > 0) {
        acc.ratios.push(o.sold_price / o.listing_price);
      }
    }
    byCategory.set(category, acc);
  }

  const categories: CategoryOutcomeSignal[] = [...byCategory.entries()]
    .map(([category, a]) => ({
      garment_category: category,
      graded_sales: a.sales,
      dispute_count: a.disputes,
      dispute_rate: a.sales > 0 ? a.disputes / a.sales : 0,
      mean_sold_to_listing_ratio:
        a.ratios.length > 0 ? a.ratios.reduce((s, v) => s + v, 0) / a.ratios.length : null,
      grade_price_correlation:
        a.grades.length >= 2 ? pearsonCorrelation(a.grades, a.soldPrices) : null,
    }))
    .sort((x, y) => y.dispute_rate - x.dispute_rate);

  return {
    categories,
    total_graded_sales: totalSales,
    overall_dispute_rate: totalSales > 0 ? totalDisputes / totalSales : 0,
    generated_at: new Date().toISOString(),
  };
}
