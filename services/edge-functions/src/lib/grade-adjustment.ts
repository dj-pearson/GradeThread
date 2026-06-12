// Shared grade-adjustment write (US-474) — used by BOTH the low-confidence
// review queue (/api/admin/grading/review/:id/adjust) and dispute resolution
// (/api/admin/disputes/:id/resolve).
//
// Applies per-factor score corrections to a grade_reports row, reseals the
// certificate integrity hash when the report is certified (US-475 — only the
// edge holds CERT_SIGNING_KEY, so the browser never could), and VERIFIES a row
// actually changed (updateByIdChecked). Both call sites previously had their own
// copy of this logic; centralizing it keeps the reseal + row-count guarantees
// identical and unit-testable against an injected client.

import {
  type CheckedUpdateClient,
  updateByIdChecked,
} from "./db-write.ts";
import {
  computeWeightedOverall,
  type FactorScores,
  resealCertificate,
  scoreToGradeTier,
} from "./human-review.ts";

// The grade_reports fields the adjustment needs: the id to target, plus the
// certified fields the reseal hash must cover (ai_summary + buyer_writeup are
// unchanged by a score edit but still feed the v2 hash).
export interface AdjustableReport {
  id: string;
  certificate_id: string | null;
  ai_summary: string;
  buyer_writeup: string | null;
}

export interface GradeAdjustmentResult {
  overall_score: number;
  grade_tier: string;
  resealed: boolean;
}

/**
 * Write corrected factor scores to a grade_reports row, reseal its certificate
 * when certified, and confirm the row changed. Throws ZeroRowsAffectedError if
 * the id matched nothing (so the caller surfaces a real error, not a false save).
 *
 * `extra` carries call-site-specific columns (e.g. human_reviewed/needs_human_review
 * for the review queue) merged into the same atomic update.
 */
export async function applyGradeAdjustment(
  db: CheckedUpdateClient,
  report: AdjustableReport,
  factors: FactorScores,
  extra: Record<string, unknown> = {},
): Promise<GradeAdjustmentResult> {
  const overall = computeWeightedOverall(factors);
  const tier = scoreToGradeTier(overall);

  const update: Record<string, unknown> = {
    overall_score: overall,
    grade_tier: tier,
    ...factors,
    ...extra,
  };

  let resealed = false;
  if (report.certificate_id) {
    const integrity = await resealCertificate({
      certificate_id: report.certificate_id,
      overall_score: overall,
      grade_tier: tier,
      ...factors,
      ai_summary: report.ai_summary,
      buyer_writeup: report.buyer_writeup,
    });
    update.content_hash = integrity.content_hash;
    update.content_signature = integrity.content_signature;
    update.integrity_version = integrity.integrity_version;
    resealed = true;
  }

  await updateByIdChecked(db, "grade_reports", report.id, update);
  return { overall_score: overall, grade_tier: tier, resealed };
}
