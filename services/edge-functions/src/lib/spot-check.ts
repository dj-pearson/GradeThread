// US-3524: blind spot checks on auto-approved grades.
//
// A grade at or above the auto-approve threshold goes live with no human
// looking, and the review queue shows every reviewer the AI's answer first.
// So confidence calibration and AI-vs-human agreement were measured only on
// low-confidence grades, by reviewers anchored to the AI. A small random share
// of auto-approved grades is flagged here; an admin scores it WITHOUT seeing
// the AI grade (routes/admin-grading.ts /spot-checks), and the score lands as
// a human_reviews row with review_action 'spot_check'. The published grade is
// not changed. review-baseline.ts reads that row's adjusted_score as the human
// answer, so accuracy, calibration and exemplars all pick it up.

import { supabaseAdmin } from "./supabase.ts";

/** Share of auto-approved grades sampled. GRADING_SPOT_CHECK_RATE, default 3%. */
export function spotCheckRate(
  raw = Deno.env.get("GRADING_SPOT_CHECK_RATE"),
): number {
  if (raw === undefined || raw.trim() === "") return 0.03;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.03;
  return Math.min(1, Math.max(0, n));
}

export function shouldSpotCheck(
  rate: number = spotCheckRate(),
  rand: () => number = Math.random,
): boolean {
  return rate > 0 && rand() < rate;
}

/** Flag one report. Idempotent; never throws into the pipeline. */
export async function requestSpotCheck(
  gradeReportId: string,
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from("grade_reports")
      .update({ spot_check_requested_at: new Date().toISOString() })
      .eq("id", gradeReportId)
      .is("spot_check_requested_at", null);
    if (error) {
      console.warn(
        `[spot-check] request for ${gradeReportId} failed: ${error.message}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `[spot-check] request for ${gradeReportId} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
