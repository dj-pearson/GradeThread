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
import { issueConfirmationReward } from "./buyer-rewards.ts";

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

// ─── Pure: anti-gaming outcome filter (US-1912 AC2) ─────────────────────────

/** One raw buyer-arrival outcome row, as read from grade_outcomes. */
export interface SellerOutcomeRow {
  buyer_user_id: string | null;
  match_status: string | null; // "confirmed" | "disputed" | …
  dispute_severity: string | null; // "cosmetic" | "material" | null
  /**
   * True once this outcome's dispute has been RESOLVED by human review (US-1812).
   * When undefined, the resolution state is unknown and — under
   * `requireResolvedDispute` — the disputed outcome is treated as NOT yet counting
   * (a dispute never dents a seller's score until an expert has ruled on it).
   */
  dispute_resolved?: boolean;
}

export interface CountableOutcomeOptions {
  /** The seller whose integrity is being computed. */
  sellerUserId: string;
  /**
   * Accounts linked to the seller (same person / colluding). A confirmation from
   * any of these — like a self-purchase — is excluded so a seller can't inflate
   * their own score. Reuses the referral self-click-blocking idea (US-864).
   */
  linkedUserIds?: ReadonlySet<string>;
  /**
   * When true (default), a disputed outcome counts ONLY once `dispute_resolved`
   * is true — an unresolved dispute is excluded entirely (not bad, not total) so a
   * frivolous dispute can't dent a seller's score before an expert rules (AC2).
   */
  requireResolvedDispute?: boolean;
}

/**
 * US-1912 AC2 — turn raw buyer-arrival outcomes into anti-gamed
 * SellerIntegrityCounts: drop self-purchase + linked-account confirmations, and
 * (by default) count a dispute only after human-review resolution. Pure; the
 * impure recompute assembles the rows and passes them here. Confirmations from
 * excluded accounts are dropped entirely; a resolved MATERIAL dispute counts
 * double (mirrors computeSellerIntegrityScore's weighting via material_dispute_count).
 */
export function countableSellerOutcomes(
  rows: readonly SellerOutcomeRow[],
  opts: CountableOutcomeOptions,
): SellerIntegrityCounts {
  const linked = opts.linkedUserIds ?? new Set<string>();
  const requireResolved = opts.requireResolvedDispute ?? true;
  let confirmed = 0;
  let disputed = 0;
  let material = 0;
  for (const r of rows) {
    const buyer = r.buyer_user_id;
    // Self-purchase / linked-account confirmations never count (anti-gaming).
    if (buyer && (buyer === opts.sellerUserId || linked.has(buyer))) continue;
    if (r.match_status === "confirmed") {
      confirmed++;
    } else if (r.match_status === "disputed") {
      // A dispute counts only once resolved by human review (default).
      if (requireResolved && r.dispute_resolved !== true) continue;
      disputed++;
      if (r.dispute_severity === "material") material++;
    }
  }
  return {
    confirmed_count: confirmed,
    disputed_count: disputed,
    material_dispute_count: material,
    total_outcomes: confirmed + disputed,
  };
}

// ─── Pure: seller integrity TIERS (US-1912) ─────────────────────────────────

/**
 * Anti-gaming display floor: below this many CONFIRMED buyer outcomes we never
 * show a tier (one lucky/unlucky early outcome shouldn't mint a public rank).
 * A seller under the floor reads as "building history", never a bad score.
 */
export const MIN_CONFIRMED_FOR_TIER = 10;

export type SellerIntegrityTier =
  | "building"
  | "verified"
  | "reliable"
  | "trusted"
  | "elite";

export interface SellerIntegrityTierInputs {
  /** 0–100 from computeSellerIntegrityScore. */
  integrityScore: number;
  /**
   * Confirmed buyer outcomes. MUST already exclude self-purchases / linked-
   * account confirmations (reuse the referral self-click blocking) and count
   * disputes only AFTER human-review resolution — this pure function trusts the
   * counts it's given.
   */
  confirmedCount: number;
  /** Average photo-coverage % (0–100), or null when unknown (then not gated on). */
  avgCoveragePct?: number | null;
  /** Lifetime graded volume. */
  gradedVolume?: number;
  /** Account tenure in days. */
  tenureDays?: number;
}

export interface SellerIntegrityTierResult {
  tier: SellerIntegrityTier;
  label: string;
  /** false below the confirmed-volume floor — the UI shows "building history". */
  displayable: boolean;
  /** Transparent, explainable drivers of the current tier. */
  reasons: string[];
  nextTier: SellerIntegrityTier | null;
  /** What the seller needs to reach nextTier. */
  nextTierGaps: string[];
}

interface TierRule {
  tier: SellerIntegrityTier;
  label: string;
  minScore: number;
  minConfirmed: number;
  /** Gated ONLY when the value is known (null coverage/tenure never blocks). */
  minCoveragePct?: number;
  minTenureDays?: number;
  minGradedVolume?: number;
}

// Best → worst. Thresholds are the policy — legible by design. "verified" is the
// baseline every above-floor seller meets (minScore 0), so a rule always matches.
const TIER_LADDER: readonly TierRule[] = [
  { tier: "elite", label: "Elite Grader", minScore: 98, minConfirmed: 50, minCoveragePct: 90, minTenureDays: 180, minGradedVolume: 100 },
  { tier: "trusted", label: "Trusted Grader", minScore: 95, minConfirmed: 25, minCoveragePct: 75, minTenureDays: 90, minGradedVolume: 40 },
  { tier: "reliable", label: "Reliable Grader", minScore: 90, minConfirmed: 10 },
  { tier: "verified", label: "Verified Grader", minScore: 0, minConfirmed: 10 },
];

/**
 * Map an integrity score + volume/coverage/tenure to a named, explainable tier
 * (US-1912 AC1/AC2). Anti-gameable via the confirmed-volume floor; coverage and
 * tenure gate the top tiers only when known. Pure + deterministic.
 */
export function sellerIntegrityTier(
  inputs: SellerIntegrityTierInputs,
): SellerIntegrityTierResult {
  const { integrityScore, confirmedCount } = inputs;
  const coverage = inputs.avgCoveragePct ?? null;
  const tenure = inputs.tenureDays ?? null;
  const volume = inputs.gradedVolume ?? 0;

  if (confirmedCount < MIN_CONFIRMED_FOR_TIER) {
    return {
      tier: "building",
      label: "Building history",
      displayable: false,
      reasons: [
        `${confirmedCount}/${MIN_CONFIRMED_FOR_TIER} confirmed buyer outcomes — a tier appears once you reach ${MIN_CONFIRMED_FOR_TIER}.`,
      ],
      nextTier: "verified",
      nextTierGaps: [`${MIN_CONFIRMED_FOR_TIER - confirmedCount} more confirmed outcomes`],
    };
  }

  const meets = (r: TierRule): boolean =>
    integrityScore >= r.minScore &&
    confirmedCount >= r.minConfirmed &&
    (r.minCoveragePct == null || coverage == null || coverage >= r.minCoveragePct) &&
    (r.minTenureDays == null || tenure == null || tenure >= r.minTenureDays) &&
    (r.minGradedVolume == null || volume >= r.minGradedVolume);

  let idx = TIER_LADDER.findIndex(meets);
  if (idx < 0) idx = TIER_LADDER.length - 1; // baseline always applies above the floor
  const rule = TIER_LADDER[idx]!;

  const reasons = [
    `Integrity ${integrityScore}/100 across ${confirmedCount} confirmed buyer outcomes.`,
  ];
  if (coverage != null) reasons.push(`Average photo coverage ${Math.round(coverage)}%.`);

  const nextRule = idx > 0 ? TIER_LADDER[idx - 1]! : null;
  const gaps: string[] = [];
  if (nextRule) {
    if (integrityScore < nextRule.minScore) gaps.push(`integrity ≥ ${nextRule.minScore}`);
    if (confirmedCount < nextRule.minConfirmed) {
      gaps.push(`${nextRule.minConfirmed - confirmedCount} more confirmed outcomes`);
    }
    if (nextRule.minCoveragePct != null && (coverage ?? 0) < nextRule.minCoveragePct) {
      gaps.push(`avg photo coverage ≥ ${nextRule.minCoveragePct}%`);
    }
    if (nextRule.minTenureDays != null && (tenure ?? 0) < nextRule.minTenureDays) {
      gaps.push(`${nextRule.minTenureDays}-day account tenure`);
    }
    if (nextRule.minGradedVolume != null && volume < nextRule.minGradedVolume) {
      gaps.push(`${nextRule.minGradedVolume - volume} more graded items`);
    }
  }

  return {
    tier: rule.tier,
    label: rule.label,
    displayable: true,
    reasons,
    nextTier: nextRule?.tier ?? null,
    nextTierGaps: gaps,
  };
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
      // US-1912 AC2: buyer_user_id drives the self/linked-account exclusion;
      // human_review_flagged tells us a dispute went to the review queue.
      .select("buyer_user_id, match_status, dispute_severity, human_review_flagged")
      .eq("seller_user_id", sellerUserId)
      .eq("source", "buyer_arrival");
    if (error) {
      console.error("[BuyerGradeConfirm] seller integrity load failed:", error.message);
      return null;
    }
    // US-1912 AC2 anti-gaming: drop self-purchase/linked-account confirmations and
    // count a dispute only after human-review resolution. We approximate
    // "resolved" as "was NOT flagged into the review queue" — a material dispute
    // (human_review_flagged=true) stays PENDING (uncounted, benefit-of-the-doubt to
    // the seller) until an expert rules; a minor dispute that never needed review
    // counts immediately. Re-counting a flagged dispute once its human review
    // RESOLVES still needs the grade_reports/human_reviews join (remaining AC2).
    const outcomeRows: SellerOutcomeRow[] = (data ?? []).map((r) => {
      const row = r as {
        buyer_user_id: string | null;
        match_status: string | null;
        dispute_severity: string | null;
        human_review_flagged: boolean | null;
      };
      return {
        buyer_user_id: row.buyer_user_id,
        match_status: row.match_status,
        dispute_severity: row.dispute_severity,
        dispute_resolved: row.human_review_flagged !== true,
      };
    });
    const counts = countableSellerOutcomes(outcomeRows, { sellerUserId });
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
  /** US-1813: reward credits issued for this confirmation (0 if none). */
  rewardCreditsIssued: number;
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

  // 3. Buyer Trust Score — a confirmation is the strongest honest-buyer signal —
  //    and the US-1813 reward credit (anti-abuse gated + idempotent in the RPC).
  let trustScore: number | null = null;
  let rewardCreditsIssued = 0;
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
    // Idempotent on purchase.id — a re-confirm never double-credits.
    rewardCreditsIssued = await issueConfirmationReward(userId, purchase.id);
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
    rewardCreditsIssued,
  };
}
