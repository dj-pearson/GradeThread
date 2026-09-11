// US-1557: scheduled confidence calibration.
//
// Mines (confidence_score, |AI overall − human-final overall|) pairs from
// human-reviewed grades, derives per-category review thresholds targeting the
// configured shipped-error rate, and persists the whole calibration (incl.
// reliability curves for the admin view) to the system_settings registry.
// PRESERVES the operator's `enabled` flag across recomputes — the job never
// turns enforcement on; a human does (shadow-first rollout, AC4).
//
// Mounted in main.ts as POST /api/jobs/confidence-calibration, job-secret
// gated; schedule weekly on Coolify (COOLIFY.md + CRON_REGISTRY).

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  binReliability,
  CALIBRATION_SETTING_KEY,
  type CalibrationPair,
  type CalibrationSetting,
  type CategoryCalibration,
  DEFAULT_TARGET_ERROR_RATE,
  deriveThreshold,
  EMPTY_CALIBRATION,
} from "../lib/confidence-calibration.ts";
import { reviewConfidenceThreshold } from "../lib/ai-config.ts";
import {
  buildReviewedGrades,
  REVIEW_BASELINE_COLUMNS,
  type ReviewBaselineRow,
  signedOverallError,
} from "../lib/review-baseline.ts";

// Bounded mining window: recent-enough to reflect the current prompts, big
// enough for per-category sample sizes.
const REVIEW_SCAN_CAP = 5000;
const SCAN_WINDOW_DAYS = 365;

export async function handleConfidenceCalibrationCron(
  c: Context,
): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("confidence-calibration", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const since = new Date(
      Date.now() - SCAN_WINDOW_DAYS * 86_400_000,
    ).toISOString();

    // 1. Reviews in the window. buildReviewedGrades collapses them to one entry
    //    per grade below: AI side from the earliest review's snapshot, human
    //    side from the report (US-3323).
    const { data: reviewRows, error: reviewErr } = await supabaseAdmin
      .from("human_reviews")
      .select(REVIEW_BASELINE_COLUMNS)
      .gte("reviewed_at", since)
      .order("reviewed_at", { ascending: false })
      .limit(REVIEW_SCAN_CAP);
    if (reviewErr) throw new Error(`review scan failed: ${reviewErr.message}`);
    const reviews = (reviewRows ?? []) as unknown as ReviewBaselineRow[];
    if (reviews.length === 0) {
      return c.json({ ok: true, skipped: true, reason: "no reviews in window" });
    }

    // 2. Reports (AI confidence) + submissions (category).
    const reportIds = [...new Set(reviews.map((r) => r.grade_report_id))];
    const { data: reportRows } = await supabaseAdmin
      .from("grade_reports")
      .select("id, overall_score, confidence_score, submission_id")
      .in("id", reportIds);
    const reportById = new Map(
      ((reportRows ?? []) as Array<{
        id: string;
        overall_score: number;
        confidence_score: number;
        submission_id: string;
      }>).map((r) => [r.id, r]),
    );
    const submissionIds = [
      ...new Set([...reportById.values()].map((r) => r.submission_id)),
    ];
    const { data: subRows } = await supabaseAdmin
      .from("submissions")
      .select("id, garment_category")
      .in("id", submissionIds);
    const categoryBySub = new Map(
      ((subRows ?? []) as Array<{ id: string; garment_category: string }>)
        .map((s) => [s.id, s.garment_category]),
    );

    // 3. Pairs per category. A review WITHOUT an adjustment is an approval —
    //    absError 0 — which is exactly the "the AI was right" signal the
    //    curve needs; dropping approvals would bias every bin pessimistic.
    //    US-3323: an ADJUSTMENT used to be absError 0 too, because the report's
    //    overall_score is the human's once adjusted. That taught the curve the
    //    AI is never wrong, and a threshold derived from it only ever falls.
    //    A send-back is not a verdict at all and is dropped by the helper.
    const pairsByCategory = new Map<string, CalibrationPair[]>();
    for (const grade of buildReviewedGrades(reviews, reportById)) {
      const report = reportById.get(grade.gradeReportId)!;
      if (!Number.isFinite(report.confidence_score)) continue;
      const category =
        (categoryBySub.get(report.submission_id) ?? "unknown").toLowerCase();
      const pair: CalibrationPair = {
        confidence: report.confidence_score,
        absError: Math.abs(signedOverallError(grade)),
      };
      const arr = pairsByCategory.get(category) ?? [];
      arr.push(pair);
      pairsByCategory.set(category, arr);
    }

    // 4. Derive per category; preserve the operator's flags across recomputes.
    const prior = await getSetting<CalibrationSetting>(
      CALIBRATION_SETTING_KEY,
      EMPTY_CALIBRATION,
    );
    const targetErrorRate =
      Number.isFinite(prior.target_error_rate) && prior.target_error_rate > 0
        ? prior.target_error_rate
        : DEFAULT_TARGET_ERROR_RATE;
    const flat = reviewConfidenceThreshold();
    const categories: Record<string, CategoryCalibration> = {};
    for (const [category, pairs] of pairsByCategory) {
      if (category === "unknown") continue;
      const derived = deriveThreshold(pairs, {
        targetErrorRate,
        fallback: flat,
      });
      if (derived.usedFallback) continue; // under-sampled → stays on the flat rule
      categories[category] = {
        threshold: derived.threshold,
        sample_size: derived.sampleSize,
        shipped_error_rate: derived.shippedErrorRate,
        curve: binReliability(pairs),
      };
    }

    const next: CalibrationSetting = {
      enabled: prior.enabled === true, // NEVER auto-enable
      target_error_rate: targetErrorRate,
      computed_at: new Date().toISOString(),
      categories,
    };

    const { error: writeErr } = await supabaseAdmin
      .from("system_settings")
      .upsert(
        {
          key: CALIBRATION_SETTING_KEY,
          value: next,
          value_type: "json",
          default_value: EMPTY_CALIBRATION,
          description:
            "US-1557 per-category review-confidence calibration (job-computed; set enabled:true to enforce)",
          category: "grading",
        },
        { onConflict: "key" },
      );
    if (writeErr) throw new Error(`calibration write failed: ${writeErr.message}`);

    return c.json({
      ok: true,
      reviews_scanned: reviews.length,
      categories_calibrated: Object.keys(categories).length,
      enabled: next.enabled,
      flat_threshold: flat,
    });
  } catch (err) {
    console.error(
      "[confidence-calibration] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Calibration failed" }, 500);
  } finally {
    await lock.release();
  }
}
