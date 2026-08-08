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
import { recomputeTrustScore } from "./buyer-trust-score.ts";
import { grantReward } from "./rewards-engine.ts";
import { notifyUser } from "./notify.ts";
import { updatePromptVersionAccuracy } from "./accuracy-tracking.ts";
import { issueConfirmationReward } from "./buyer-rewards.ts";
import { trackBuyerFeature } from "./buyer-analytics.ts";

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

/**
 * Decide `dispute_resolved` from the REAL review state (US-1912 AC2).
 *
 * This replaces an approximation that was wrong in the seller's favour and
 * never self-corrected: `dispute_resolved = human_review_flagged !== true`. A
 * flagged dispute is one an expert was asked to rule on, so under that rule it
 * stayed uncounted FOREVER — including after the expert ruled and agreed with
 * the buyer. A seller could accumulate confirmed-material disputes and keep a
 * spotless integrity score, permanently, because the very act of escalating a
 * dispute is what excluded it.
 *
 * The benefit-of-the-doubt was right; making it permanent was not. A flagged
 * dispute is PENDING until reviewed, then it counts.
 *
 * `human_reviews` carries no status column — a ROW EXISTING is the resolution
 * (`reviewed_at` is NOT NULL DEFAULT now(), 00003). So "has a review row for
 * this grade report" is the whole predicate, not a proxy for one.
 *
 * Pure so the rule is testable without a database, which is where the previous
 * approximation hid: it was a single expression inside an async function nobody
 * could exercise.
 */
export function withDisputeResolution(
  rows: readonly (SellerOutcomeRow & {
    grade_report_id?: string | null;
    human_review_flagged?: boolean | null;
  })[],
  reviewedReportIds: ReadonlySet<string>,
): SellerOutcomeRow[] {
  return rows.map((r) => ({
    buyer_user_id: r.buyer_user_id,
    match_status: r.match_status,
    dispute_severity: r.dispute_severity,
    // Never escalated → nothing to wait for, it counts.
    // Escalated → counts only once a review row exists for its report.
    dispute_resolved: r.human_review_flagged !== true ||
      (!!r.grade_report_id && reviewedReportIds.has(r.grade_report_id)),
  }));
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
  /** Account tenure in days, or null when unknown (then not gated on). */
  tenureDays?: number | null;
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

/** Display name per tier, so a stored tier can be labelled without re-deriving it. */
export const SELLER_INTEGRITY_TIER_LABELS: Record<SellerIntegrityTier, string> = {
  building: "Building history",
  verified: "Verified Grader",
  reliable: "Reliable Grader",
  trusted: "Trusted Grader",
  elite: "Elite Grader",
};

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

// ─── Pure: tier transitions + tier inputs (US-1912 AC2/AC4) ────────────────

/** Ladder order. `building` is rank 0 — earning a first tier IS a promotion. */
export const INTEGRITY_TIER_RANK: Record<SellerIntegrityTier, number> = {
  building: 0,
  verified: 1,
  reliable: 2,
  trusted: 3,
  elite: 4,
};

export type IntegrityTierDirection = "up" | "down" | "none";

/**
 * Which way a tier moved. The two directions are treated ASYMMETRICALLY on
 * purpose (AC4): an "up" is public and rewardable, a "down" is private and
 * silent. So this has to be a real comparison rather than "did the string
 * change" — the latter would let a demotion take the celebration path.
 */
export function integrityTierDirection(
  previous: SellerIntegrityTier | null | undefined,
  next: SellerIntegrityTier,
): IntegrityTierDirection {
  const prevRank = previous ? INTEGRITY_TIER_RANK[previous] : INTEGRITY_TIER_RANK.building;
  const nextRank = INTEGRITY_TIER_RANK[next];
  if (nextRank > prevRank) return "up";
  if (nextRank < prevRank) return "down";
  return "none";
}

/** One grade report's persisted coverage record (US-1276/00308), as read. */
export interface CoverageBearingRow {
  coverage?: { coverage_pct?: unknown } | null;
}

/**
 * Average photo-coverage % across a seller's graded reports, or null when NO
 * report carries a coverage record (reports graded before 00308 have none).
 *
 * Null means UNKNOWN, and the tier ladder never gates on an unknown input — so
 * an old account is not held back by data that did not exist when it graded.
 * A non-numeric or out-of-range value is dropped rather than clamped: a value we
 * cannot read is not evidence of good coverage, and averaging it in would let a
 * malformed blob decide a public tier.
 */
export function averageCoveragePct(
  rows: readonly CoverageBearingRow[],
): number | null {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const raw = r.coverage?.coverage_pct;
    const pct = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    sum += pct;
    n++;
  }
  if (n === 0) return null;
  return Math.round((sum / n) * 10) / 10;
}

/** Whole days since `createdAt`, or null when it is missing/unparseable. */
export function tenureDaysFrom(
  createdAt: string | null | undefined,
  nowMs: number,
): number | null {
  if (!createdAt) return null;
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.floor((nowMs - started) / 86_400_000));
}

/**
 * The specific driver of a DEMOTION, in the seller's words (AC4: a tier-down
 * notice names what moved). Built from the tier result's own gaps so the private
 * notice and the seller's public explanation can never disagree — they are the
 * same computation.
 */
export function tierDownDriver(
  previous: SellerIntegrityTier,
  result: SellerIntegrityTierResult,
): string {
  const gaps = result.nextTier === previous && result.nextTierGaps.length > 0
    ? result.nextTierGaps
    : [];
  const base = `Your Grade Integrity standing moved from ${previous} to ${result.tier}.`;
  if (gaps.length === 0) return `${base} ${result.reasons.join(" ")}`;
  return `${base} To get back: ${gaps.join(", ")}.`;
}

// ─── Impure: seller integrity recompute (service-role) ──────────────────────

/**
 * How many of the seller's most recent grade reports the coverage average is
 * computed over. Bounds the work for a prolific seller; the graded VOLUME is an
 * exact count (PostgREST `count: exact`), so only the average is sampled.
 */
const INTEGRITY_COVERAGE_SAMPLE = 1000;

/** What a recompute produced, including the tier and how it moved. */
export interface SellerIntegrityRecomputeResult extends SellerIntegrityCounts {
  integrity_score: number;
  tier: SellerIntegrityTier;
  tier_displayable: boolean;
  previous_tier: SellerIntegrityTier;
  direction: IntegrityTierDirection;
  avg_coverage_pct: number | null;
  tenure_days: number | null;
  graded_volume: number;
}

/**
 * Read the tier INPUTS that don't come from buyer outcomes: average photo
 * coverage, lifetime graded volume, account tenure. Scoped to this seller
 * (US-268) — grade_reports has no user_id, so ownership flows through
 * submissions.user_id. Best-effort per input: an unreadable one degrades to
 * "unknown" (null), which the ladder never gates on, rather than to a zero that
 * would silently demote someone.
 */
async function loadSellerTierInputs(sellerUserId: string, nowMs: number): Promise<{
  avgCoveragePct: number | null;
  gradedVolume: number;
  tenureDays: number | null;
}> {
  let avgCoveragePct: number | null = null;
  let gradedVolume = 0;
  let tenureDays: number | null = null;

  const { data: reports, count, error } = await supabaseAdmin
    .from("grade_reports")
    .select("coverage, submissions!inner(user_id)", { count: "exact" })
    .eq("submissions.user_id", sellerUserId)
    .order("created_at", { ascending: false })
    .limit(INTEGRITY_COVERAGE_SAMPLE);
  if (error) {
    console.error("[BuyerGradeConfirm] tier inputs load failed:", error.message);
  } else {
    avgCoveragePct = averageCoveragePct(
      (reports ?? []) as unknown as CoverageBearingRow[],
    );
    gradedVolume = count ?? (reports ?? []).length;
  }

  const { data: userRow, error: userErr } = await supabaseAdmin
    .from("users")
    .select("created_at")
    .eq("id", sellerUserId)
    .maybeSingle();
  if (userErr) {
    console.error("[BuyerGradeConfirm] tenure load failed:", userErr.message);
  } else {
    tenureDays = tenureDaysFrom(
      (userRow as { created_at?: string | null } | null)?.created_at,
      nowMs,
    );
  }

  return { avgCoveragePct, gradedVolume, tenureDays };
}

/**
 * Recompute a seller's Grade Integrity from their buyer_arrival outcomes and
 * upsert the cache. Idempotent and reconstructable — running it twice with no
 * new outcomes yields the same row AND fires no side effect the second time
 * (the transition is decided against the STORED tier, so an unchanged tier is
 * not a change). Best-effort: logs and returns null on a DB error rather than
 * throwing (a cache-refresh failure never blocks the buyer's verdict). Scoped by
 * seller_user_id (US-268).
 */
export async function recomputeSellerGradeIntegrity(
  sellerUserId: string,
): Promise<SellerIntegrityRecomputeResult | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("grade_outcomes")
      // US-1912 AC2: buyer_user_id drives the self/linked-account exclusion;
      // human_review_flagged tells us a dispute went to the review queue, and
      // grade_report_id is what joins it to the review that resolves it.
      .select(
        "grade_report_id, buyer_user_id, match_status, dispute_severity, human_review_flagged",
      )
      .eq("seller_user_id", sellerUserId)
      .eq("source", "buyer_arrival");
    if (error) {
      console.error("[BuyerGradeConfirm] seller integrity load failed:", error.message);
      return null;
    }
    // US-1912 AC2 anti-gaming: drop self-purchase/linked-account confirmations and
    // count a dispute only after human-review resolution.
    //
    // The resolution is now READ, not approximated. This used to infer it as
    // "was NOT flagged into the review queue", which meant an escalated dispute
    // never counted — not even after the expert ruled against the seller. The
    // act of escalating was what excluded it, permanently, so a seller with
    // repeated confirmed-material disputes kept a clean score.
    const raw = (data ?? []) as Array<{
      grade_report_id: string | null;
      buyer_user_id: string | null;
      match_status: string | null;
      dispute_severity: string | null;
      human_review_flagged: boolean | null;
    }>;

    // Only the escalated ones need a review lookup, and only their reports.
    const pendingReportIds = [
      ...new Set(
        raw
          .filter((r) => r.human_review_flagged === true && r.grade_report_id)
          .map((r) => r.grade_report_id as string),
      ),
    ];
    let reviewedReportIds = new Set<string>();
    if (pendingReportIds.length > 0) {
      const { data: reviews, error: revErr } = await supabaseAdmin
        .from("human_reviews")
        .select("grade_report_id")
        .in("grade_report_id", pendingReportIds);
      if (revErr) {
        // FAIL TOWARD THE SELLER. An unreadable review table must not start
        // counting disputes nobody has confirmed — that would dent scores on a
        // database blip. Leaving the set empty reproduces the old
        // benefit-of-the-doubt for this run only, and the next recompute fixes
        // it, which is the safe direction for a public reputation number.
        console.error(
          "[BuyerGradeConfirm] human_reviews load failed; treating escalated " +
            `disputes as still pending: ${revErr.message}`,
        );
      } else {
        reviewedReportIds = new Set(
          ((reviews ?? []) as Array<{ grade_report_id: string | null }>)
            .map((r) => r.grade_report_id)
            .filter((id): id is string => !!id),
        );
      }
    }

    const outcomeRows: SellerOutcomeRow[] = withDisputeResolution(
      raw,
      reviewedReportIds,
    );
    const counts = countableSellerOutcomes(outcomeRows, { sellerUserId });
    const integrity_score = computeSellerIntegrityScore(counts);

    // US-1912 AC1: the tier and the inputs that produced it, computed and
    // STORED together so the seller's explanation and their public tier are one
    // snapshot rather than two reads that can disagree.
    const nowMs = Date.now();
    const inputs = await loadSellerTierInputs(sellerUserId, nowMs);
    const tierResult = sellerIntegrityTier({
      integrityScore: integrity_score,
      confirmedCount: counts.confirmed_count,
      avgCoveragePct: inputs.avgCoveragePct,
      gradedVolume: inputs.gradedVolume,
      tenureDays: inputs.tenureDays,
    });

    // The stored tier is the ONLY thing that says whether this recompute is a
    // change. Reading it before the write is what keeps AC5's idempotence real:
    // a recompute that lands on the same tier writes the same row and fires
    // nothing, however many times it runs.
    const { data: existingRow } = await supabaseAdmin
      .from("seller_grade_integrity")
      .select("tier")
      .eq("seller_user_id", sellerUserId)
      .maybeSingle();
    const previousTier =
      ((existingRow as { tier?: string | null } | null)?.tier as SellerIntegrityTier | undefined) ??
        "building";
    const direction = integrityTierDirection(previousTier, tierResult.tier);

    const nowIso = new Date(nowMs).toISOString();
    const { error: upErr } = await supabaseAdmin
      .from("seller_grade_integrity")
      .upsert(
        {
          seller_user_id: sellerUserId,
          ...counts,
          integrity_score,
          tier: tierResult.tier,
          tier_displayable: tierResult.displayable,
          avg_coverage_pct: inputs.avgCoveragePct,
          graded_volume: inputs.gradedVolume,
          tenure_days: inputs.tenureDays,
          // Only a real move rewrites the transition bookkeeping — an unchanged
          // tier must not keep bumping tier_changed_at, or "when did this last
          // move" becomes "when did we last recompute".
          ...(direction === "none"
            ? {}
            : { previous_tier: previousTier, tier_changed_at: nowIso }),
          updated_at: nowIso,
        } as never,
        { onConflict: "seller_user_id" },
      );
    if (upErr) {
      console.error("[BuyerGradeConfirm] seller integrity upsert failed:", upErr.message);
      return null;
    }

    // AC4 side effects. Best-effort and AFTER the write, so a notification
    // problem can never lose the recomputed standing itself.
    if (direction !== "none") {
      await announceIntegrityTierChange(sellerUserId, previousTier, tierResult, direction);
    }

    return {
      ...counts,
      integrity_score,
      tier: tierResult.tier,
      tier_displayable: tierResult.displayable,
      previous_tier: previousTier,
      direction,
      avg_coverage_pct: inputs.avgCoveragePct,
      tenure_days: inputs.tenureDays,
      graded_volume: inputs.gradedVolume,
    };
  } catch (err) {
    console.error(
      "[BuyerGradeConfirm] recomputeSellerGradeIntegrity failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * US-1912 AC4 — tell the right audience, the right way, about a tier move.
 *
 * The asymmetry IS the feature, so it is worth stating plainly: a promotion is
 * public and rewardable (a reputation event, which the rewards read turns into
 * the US-1857 celebration); a demotion is private, named, and announced to
 * nobody but the seller. There is deliberately no `integrity_tier_down` event
 * type — the reputation ledger feeds public surfaces, so a demotion event would
 * BE the public announcement this AC forbids, no matter how it were rendered.
 *
 * Both halves are best-effort: a failure here must never undo the standing that
 * was already written, and the next recompute is not a retry (the tier already
 * matches, so nothing re-fires). That is the safe direction — a missed
 * congratulation costs nothing, while a lost integrity recompute is real data.
 */
async function announceIntegrityTierChange(
  sellerUserId: string,
  previousTier: SellerIntegrityTier,
  result: SellerIntegrityTierResult,
  direction: IntegrityTierDirection,
): Promise<void> {
  try {
    if (direction === "up") {
      // Deduped on the tier REACHED, so re-climbing to a tier after a demotion
      // never pays a second time.
      await grantReward(sellerUserId, "integrity_tier_up", {
        referenceId: `integrity_tier:${result.tier}`,
        metadata: {
          tier: result.tier,
          previous_tier: previousTier,
          label: result.label,
        },
        source: "integrity",
      });
      return;
    }
    // A demotion. Private, and it says WHAT moved — a reputation number that
    // drops without a reason is the thing sellers cannot act on.
    await notifyUser(sellerUserId, {
      type: "integrity_tier_change",
      title: "Your Grade Integrity standing changed",
      message: tierDownDriver(previousTier, result),
      link: "/dashboard/rewards",
    });
  } catch (err) {
    console.error(
      "[BuyerGradeConfirm] integrity tier announcement failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─── Impure: reading a stored standing (service-role) ──────────────────────

/** The seller's own, fully-explained standing (AC1 — "the seller can view"). */
export interface SellerIntegrityStanding {
  tier: SellerIntegrityTier;
  label: string;
  displayable: boolean;
  integrity_score: number;
  confirmed_count: number;
  disputed_count: number;
  avg_coverage_pct: number | null;
  tenure_days: number | null;
  graded_volume: number;
  reasons: string[];
  next_tier: SellerIntegrityTier | null;
  next_tier_gaps: string[];
  tier_changed_at: string | null;
}

interface StoredIntegrityRow {
  tier: string | null;
  tier_displayable: boolean | null;
  integrity_score: number | string | null;
  confirmed_count: number | null;
  disputed_count: number | null;
  avg_coverage_pct: number | string | null;
  tenure_days: number | null;
  graded_volume: number | null;
  tier_changed_at: string | null;
}

const STORED_INTEGRITY_COLUMNS =
  "tier, tier_displayable, integrity_score, confirmed_count, disputed_count, " +
  "avg_coverage_pct, tenure_days, graded_volume, tier_changed_at";

/** A seller with no outcomes yet still has a standing: the pre-floor one. */
function emptyStanding(): SellerIntegrityStanding {
  const derived = sellerIntegrityTier({ integrityScore: 100, confirmedCount: 0 });
  return {
    tier: "building",
    label: SELLER_INTEGRITY_TIER_LABELS.building,
    displayable: false,
    integrity_score: 100,
    confirmed_count: 0,
    disputed_count: 0,
    avg_coverage_pct: null,
    tenure_days: null,
    graded_volume: 0,
    reasons: derived.reasons,
    next_tier: derived.nextTier,
    next_tier_gaps: derived.nextTierGaps,
    tier_changed_at: null,
  };
}

/**
 * Load a seller's own standing with the full explanation (AC1). Scoped to the
 * caller's own user id (US-268).
 *
 * The STORED tier is the answer — it is what the public surfaces show, so the
 * seller's screen must agree with it. The explanation is re-derived from the
 * stored INPUT snapshot rather than from live reads, so the reasons on screen
 * describe the same moment the tier came from. (If the ladder is edited between
 * recomputes the two can briefly disagree on the derived tier; the stored one
 * still wins, because that is the one buyers are being shown.)
 */
export async function loadSellerIntegrityStanding(
  sellerUserId: string,
): Promise<SellerIntegrityStanding> {
  try {
    const { data, error } = await supabaseAdmin
      .from("seller_grade_integrity")
      .select(STORED_INTEGRITY_COLUMNS)
      .eq("seller_user_id", sellerUserId)
      .maybeSingle();
    if (error) throw error;
    const row = data as unknown as StoredIntegrityRow | null;
    if (!row) return emptyStanding();

    const integrityScore = Number(row.integrity_score ?? 100);
    const confirmed = row.confirmed_count ?? 0;
    const coverage = row.avg_coverage_pct == null ? null : Number(row.avg_coverage_pct);
    const derived = sellerIntegrityTier({
      integrityScore,
      confirmedCount: confirmed,
      avgCoveragePct: coverage,
      gradedVolume: row.graded_volume ?? 0,
      tenureDays: row.tenure_days,
    });
    const tier = (row.tier as SellerIntegrityTier | null) ?? derived.tier;
    return {
      tier,
      label: SELLER_INTEGRITY_TIER_LABELS[tier] ?? derived.label,
      displayable: row.tier_displayable ?? derived.displayable,
      integrity_score: integrityScore,
      confirmed_count: confirmed,
      disputed_count: row.disputed_count ?? 0,
      avg_coverage_pct: coverage,
      tenure_days: row.tenure_days,
      graded_volume: row.graded_volume ?? 0,
      reasons: derived.reasons,
      next_tier: derived.nextTier,
      next_tier_gaps: derived.nextTierGaps,
      tier_changed_at: row.tier_changed_at,
    };
  } catch (err) {
    console.error(
      "[BuyerGradeConfirm] integrity standing load failed:",
      err instanceof Error ? err.message : String(err),
    );
    return emptyStanding();
  }
}

/** The PUBLIC projection: a tier name and nothing else. */
export interface PublicSellerIntegrity {
  tier: SellerIntegrityTier;
  label: string;
}

/**
 * US-1912 AC3 — the tier for a PUBLIC surface (verified profile, certificate).
 *
 * Returns null unless the stored tier is DISPLAYABLE, which is the anti-gaming
 * floor from AC2 doing its job at the read: a seller under the floor shows
 * nothing at all, never "building history" rendered as a low rank and never a
 * score. Nothing else about the seller — no counts, no dispute numbers, no
 * coverage, no id — crosses this boundary; a tier name is a rank, while the
 * counts underneath it are a business metric that belongs to the seller.
 */
export async function loadPublicSellerIntegrity(
  sellerUserId: string,
): Promise<PublicSellerIntegrity | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("seller_grade_integrity")
      .select("tier, tier_displayable")
      .eq("seller_user_id", sellerUserId)
      .eq("tier_displayable", true)
      .maybeSingle();
    if (error) throw error;
    const row = data as { tier: string | null } | null;
    const tier = row?.tier as SellerIntegrityTier | undefined;
    if (!tier || tier === "building") return null;
    return { tier, label: SELLER_INTEGRITY_TIER_LABELS[tier] };
  } catch (err) {
    // Fail CLOSED on a public surface: an unreadable standing shows no badge
    // rather than a stale or default one. A missing badge is a non-event; a
    // wrong badge is a trust claim we did not verify.
    console.error(
      "[BuyerGradeConfirm] public integrity load failed:",
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
      // US-1849 AC5: ONE ledger. This goes through grantReward rather than a bare
      // emit so the same row feeds BOTH tracks — the buyer Trust Score reads it
      // as `grade_confirmed`, and the XP scorer scores it and refreshes
      // user_reward_state in the same beat. A bare emit still landed the trust
      // row but left XP stale until some unrelated action recomputed it.
      //
      // `paid: true` is the truth for AC4's grading-spend gate: this confirmation
      // is against a FINALIZED public certificate, which only exists on a grade
      // that was charged for and never reversed. Idempotent on the purchase id,
      // so a re-confirm never double-awards.
      await grantReward(userId, "grade_confirmed", {
        verified: true,
        paid: true,
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

  // US-1845: a confirmation is both a feature use and the flywheel's hinge — it
  // is buyer effort that feeds back into grading accuracy. Outcome shape only,
  // never the item, the seller or the price.
  trackBuyerFeature(userId, "confirmations", verdict.matchStatus, {
    guarantee_eligible: guaranteeEligible,
    human_review_flagged: humanReviewFlagged,
    reward_credits: rewardCreditsIssued,
  });

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
