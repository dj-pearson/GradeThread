// US-1812: buyer grade confirm/dispute engine + grading feedback loop.
//
// A buyer confirms (or disputes) that a purchased item matched its GradeThread
// grade. That single post-sale verdict fans out to FOUR consumers — the whole
// two-sided moat rides on this function:
//   1. grade_outcomes  — a structured `buyer_arrival` outcome row (match_status,
//      per-factor deltas, dispute reason/severity) that the accuracy pipeline
//      (computeOutcomeFeedback) already knows how to read.
//   2. human-review    — a MATERIAL dispute flips the grade_report into the
//      review queue (needs_human_review) so an expert re-grades it; the expert's
//      correction — never the buyer's coarse verdict — is what moves
//      ai_prompt_versions.accuracy_score. A buyer is not an expert reviewer, so
//      we route, we don't fabricate a human_reviews correction (grading-engine
//      golden-set rule).
//   3. buyer Trust Score (US-1817) — a confirmation emits a `grade_confirmed`
//      reputation event (a dispute's upheld/overturned scoring is decided later,
//      at resolution, so filing one scores nothing yet).
//   4. seller Grade Integrity (US-1912 substrate) — recomputed from the seller's
//      buyer_arrival outcomes.
// Plus: a material mismatch inside an eligible coverage window is marked
// guarantee_eligible so the US-1821 claim intake can pick it up.
//
// The pure helpers (score/severity/eligibility) are unit-tested without a DB.
// The orchestrator is service-role; the caller has already verified the buyer
// owns the purchase (US-268).

import { supabaseAdmin } from "./supabase.ts";
import {
  type ClaimFactorDeltas,
  mapClaimIssuesToFactorDeltas,
  normalizeClaimIssues,
} from "./claim-accuracy.ts";
import { emitReputationEvent, recomputeTrustScore } from "./buyer-trust-score.ts";
import { updatePromptVersionAccuracy } from "./accuracy-tracking.ts";

/** Buyer's structured mismatch report — same shape as a guarantee claim issue. */
export interface BuyerConfirmInput {
  matchStatus: "confirmed" | "disputed";
  /** Structured mismatches ({ defect, severity, location }); optional. */
  issues?: unknown;
  disputeReason?: string | null;
}

// ─── Pure: dispute severity ─────────────────────────────────────────────────

/**
 * A dispute is MATERIAL when the buyer's structured issues imply an over-grade
 * at least as large as the coverage grade-delta threshold; otherwise COSMETIC.
 * A dispute with no structured issues (free text only) yields overall_delta 0 →
 * cosmetic: we never manufacture a material signal from prose. Pure.
 */
export function deriveDisputeSeverity(
  overallDelta: number,
  gradeDeltaThreshold: number,
): "material" | "cosmetic" {
  return overallDelta >= gradeDeltaThreshold && gradeDeltaThreshold > 0
    ? "material"
    : "cosmetic";
}

// ─── Pure: guarantee eligibility ────────────────────────────────────────────

/** The frozen coverage snapshot fields this decision needs (from purchase_coverage). */
export interface CoverageSnapshot {
  eligible: boolean;
  coveredUntil: string | null;
  gradeDeltaThreshold: number;
}

/**
 * A material dispute qualifies for guarantee coverage (US-1821 picks it up) when
 * the purchase's frozen coverage was eligible, we're still inside the window, and
 * the implied over-grade meets the threshold. Pure (nowMs injected).
 */
export function decideGuaranteeEligible(input: {
  matchStatus: "confirmed" | "disputed";
  severity: "material" | "cosmetic";
  overallDelta: number;
  coverage: CoverageSnapshot | null;
  nowMs: number;
}): boolean {
  if (input.matchStatus !== "disputed" || input.severity !== "material") return false;
  const cov = input.coverage;
  if (!cov || !cov.eligible) return false;
  if (input.overallDelta < cov.gradeDeltaThreshold) return false;
  if (cov.coveredUntil) {
    const until = Date.parse(cov.coveredUntil);
    if (Number.isFinite(until) && input.nowMs > until) return false;
  }
  return true;
}

// ─── Pure: seller integrity score ───────────────────────────────────────────

/** Below this many outcomes the score is smoothed toward 100 (benefit of the
 *  doubt) so one early dispute can't crater a new seller's integrity. */
export const MIN_INTEGRITY_SAMPLE = 5;

export interface SellerIntegrityCounts {
  confirmed_count: number;
  disputed_count: number;
  material_dispute_count: number;
  total_outcomes: number;
}

/**
 * 0–100 seller Grade Integrity. Legible by design (this formula IS the policy):
 * a dispute counts once, a MATERIAL dispute counts twice, and the "bad" weight
 * is divided by the sample size floored at MIN_INTEGRITY_SAMPLE so small samples
 * regress toward 100. All-confirmations (or no outcomes) → 100. Pure.
 */
export function computeSellerIntegrityScore(c: SellerIntegrityCounts): number {
  const weightedBad = c.disputed_count + c.material_dispute_count; // material ×2
  const weightedTotal = c.total_outcomes + c.material_dispute_count; // keeps ratio ≤ 1
  const effectiveTotal = Math.max(weightedTotal, MIN_INTEGRITY_SAMPLE);
  if (effectiveTotal <= 0) return 100;
  const score = 100 * (1 - weightedBad / effectiveTotal);
  return Math.round(Math.min(100, Math.max(0, score)));
}

// ─── Impure: seller integrity recompute (service-role) ──────────────────────

/**
 * Recompute a seller's Grade Integrity from their buyer_arrival outcomes and
 * upsert the cache. Idempotent and reconstructable — running it twice with no
 * new outcomes yields the same row. Best-effort: logs and returns null on a DB
 * error rather than throwing (a cache-refresh failure never blocks the buyer's
 * verdict). Scoped by seller_user_id (US-268).
 */
export async function recomputeSellerGradeIntegrity(
  sellerUserId: string,
): Promise<SellerIntegrityCounts & { integrity_score: number } | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("grade_outcomes")
      .select("match_status, dispute_severity")
      .eq("seller_user_id", sellerUserId)
      .eq("source", "buyer_arrival");
    if (error) {
      console.error("[BuyerGradeConfirm] seller integrity load failed:", error.message);
      return null;
    }
    let confirmed = 0;
    let disputed = 0;
    let material = 0;
    for (const r of data ?? []) {
      const row = r as { match_status: string | null; dispute_severity: string | null };
      if (row.match_status === "confirmed") confirmed++;
      else if (row.match_status === "disputed") {
        disputed++;
        if (row.dispute_severity === "material") material++;
      }
    }
    const counts: SellerIntegrityCounts = {
      confirmed_count: confirmed,
      disputed_count: disputed,
      material_dispute_count: material,
      total_outcomes: confirmed + disputed,
    };
    const integrity_score = computeSellerIntegrityScore(counts);
    const { error: upErr } = await supabaseAdmin
      .from("seller_grade_integrity")
      .upsert(
        {
          seller_user_id: sellerUserId,
          ...counts,
          integrity_score,
          updated_at: new Date().toISOString(),
        } as never,
        { onConflict: "seller_user_id" },
      );
    if (upErr) {
      console.error("[BuyerGradeConfirm] seller integrity upsert failed:", upErr.message);
      return null;
    }
    return { ...counts, integrity_score };
  } catch (err) {
    console.error(
      "[BuyerGradeConfirm] recomputeSellerGradeIntegrity failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ─── Impure: the orchestrator (service-role) ────────────────────────────────

export interface OwnedPurchase {
  id: string;
  grade_report_id: string;
}

export interface BuyerGradeOutcomeResult {
  matchStatus: "confirmed" | "disputed";
  factorDeltas: ClaimFactorDeltas["deltas"];
  overallDelta: number;
  disputeSeverity: "material" | "cosmetic" | null;
  guaranteeEligible: boolean;
  humanReviewFlagged: boolean;
  sellerIntegrity: { integrity_score: number } | null;
  trustScore: number | null;
}

/**
 * Record a buyer's confirm/dispute verdict for an OWNED purchase and fan it out
 * (see file header). The caller MUST have verified the buyer owns `purchase`.
 * Idempotent on (buyer_purchase_id): a re-submitted verdict updates the same
 * outcome row. `nowMs` is injectable for tests.
 */
export async function recordBuyerGradeOutcome(input: {
  userId: string;
  purchase: OwnedPurchase;
  verdict: BuyerConfirmInput;
  nowMs?: number;
}): Promise<BuyerGradeOutcomeResult> {
  const nowMs = input.nowMs ?? Date.now();
  const { userId, purchase, verdict } = input;
  const disputed = verdict.matchStatus === "disputed";

  // Resolve the graded report + its seller (submission owner) + prompt version.
  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, prompt_version, model_version, overall_score")
    .eq("id", purchase.grade_report_id)
    .maybeSingle();
  const submissionId = (report as { submission_id?: string } | null)?.submission_id ?? null;
  let sellerUserId: string | null = null;
  if (submissionId) {
    const { data: sub } = await supabaseAdmin
      .from("submissions")
      .select("user_id")
      .eq("id", submissionId)
      .maybeSingle();
    sellerUserId = (sub as { user_id?: string } | null)?.user_id ?? null;
  }

  // Map the buyer's structured issues → per-factor over-grade deltas (reuses the
  // guarantee-claim math). Confirmations carry no deltas.
  const issues = disputed ? normalizeClaimIssues(verdict.issues) : [];
  const { deltas, overall_delta } = mapClaimIssuesToFactorDeltas(issues);

  // Frozen coverage snapshot (US-1820) → severity threshold + eligibility.
  const { data: coverageRow } = await supabaseAdmin
    .from("purchase_coverage")
    .select("eligible, covered_until, grade_delta_threshold")
    .eq("purchase_id", purchase.id)
    .eq("user_id", userId)
    .maybeSingle();
  const coverage: CoverageSnapshot | null = coverageRow
    ? {
      eligible: (coverageRow as { eligible: boolean }).eligible,
      coveredUntil: (coverageRow as { covered_until: string | null }).covered_until,
      gradeDeltaThreshold:
        (coverageRow as { grade_delta_threshold: number | null }).grade_delta_threshold ?? 1.0,
    }
    : null;
  const threshold = coverage?.gradeDeltaThreshold ?? 1.0;

  const severity = disputed ? deriveDisputeSeverity(overall_delta, threshold) : null;
  const guaranteeEligible = decideGuaranteeEligible({
    matchStatus: verdict.matchStatus,
    severity: severity ?? "cosmetic",
    overallDelta: overall_delta,
    coverage,
    nowMs,
  });
  // Only a MATERIAL dispute routes into the human-review queue — a cosmetic
  // nitpick shouldn't force an expert re-grade.
  const humanReviewFlagged = disputed && severity === "material";

  const promptVersion =
    (report as { prompt_version?: string | null } | null)?.prompt_version ?? null;

  // 1. Upsert the buyer outcome (idempotent on buyer_purchase_id).
  const { error: outErr } = await supabaseAdmin
    .from("grade_outcomes")
    .upsert(
      {
        grade_report_id: purchase.grade_report_id,
        buyer_user_id: userId,
        buyer_purchase_id: purchase.id,
        seller_user_id: sellerUserId,
        match_status: verdict.matchStatus,
        factor_deltas: deltas,
        overall_delta,
        dispute_reason: disputed ? (verdict.disputeReason?.trim() || null) : null,
        dispute_severity: severity,
        prompt_version: promptVersion,
        dispute_reported: disputed,
        guarantee_eligible: guaranteeEligible,
        human_review_flagged: humanReviewFlagged,
        source: "buyer_arrival",
      } as never,
      { onConflict: "buyer_purchase_id" },
    );
  if (outErr) throw new Error(`recordBuyerGradeOutcome outcome upsert failed: ${outErr.message}`);

  // 2. Material dispute → flip the grade_report into the human-review queue so an
  //    expert re-grades it. Refresh the prompt-version accuracy aggregate (a
  //    fire-and-forget recompute; it reads expert reviews, never the buyer row).
  if (humanReviewFlagged) {
    await supabaseAdmin
      .from("grade_reports")
      .update({ needs_human_review: true })
      .eq("id", purchase.grade_report_id);
    updatePromptVersionAccuracy(purchase.grade_report_id).catch(() => {});
  }

  // 3. Buyer Trust Score — a confirmation is the strongest honest-buyer signal.
  let trustScore: number | null = null;
  if (verdict.matchStatus === "confirmed") {
    try {
      await emitReputationEvent(userId, {
        eventType: "grade_confirmed",
        verified: true,
        source: "buyer_arrival",
        referenceId: purchase.id,
        occurredAt: new Date(nowMs).toISOString(),
      });
      const res = await recomputeTrustScore(userId, nowMs);
      trustScore = res.score;
    } catch (err) {
      console.error(
        "[BuyerGradeConfirm] reputation emit/recompute failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 4. Seller Grade Integrity (US-1912 substrate).
  const sellerIntegrity = sellerUserId
    ? await recomputeSellerGradeIntegrity(sellerUserId)
    : null;

  return {
    matchStatus: verdict.matchStatus,
    factorDeltas: deltas,
    overallDelta: overall_delta,
    disputeSeverity: severity,
    guaranteeEligible,
    humanReviewFlagged,
    sellerIntegrity: sellerIntegrity ? { integrity_score: sellerIntegrity.integrity_score } : null,
    trustScore,
  };
}
