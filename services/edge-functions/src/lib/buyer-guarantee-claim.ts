// US-1821: buyer purchase-guarantee claim intake + automated remedy.
//
// A covered buyer whose arrival was MATERIALLY below grade files a claim. The
// decision is PURE (unit-tested): it rides the US-1812 confirm evidence
// (guarantee_eligible + overall_delta on the buyer_arrival grade_outcome) and the
// US-1820 frozen coverage snapshot, computes a remedy within the cap, and either
// auto-approves (grant reward credits now) or routes to manual review. The
// orchestrator is service-role; the caller has verified the buyer owns the
// purchase (US-268).

import { supabaseAdmin } from "./supabase.ts";
import { captureException, recordMetric } from "./observability.ts";
import { getSetting } from "./system-settings.ts";
import { notifyBuyer } from "./buyer-notify.ts";
import { trackBuyerFeature } from "./buyer-analytics.ts";
import {
  getGuaranteePoolConfig,
  periodKey,
  poolDrawdownRef,
  reservePoolDrawdown,
} from "./guarantee-pool.ts";
import {
  DEFAULT_GUARANTEE_FRAUD_CONFIG,
  evaluateFraudSignals,
  type FraudVerdict,
  GUARANTEE_FRAUD_SETTING_KEY,
  normalizeGuaranteeFraudConfig,
} from "./guarantee-fraud.ts";
import { CLUSTER_WINDOW_DAYS, correlatedBatchHold } from "./authenticity-seller-signal.ts";

const ARRIVAL_TYPE_COUNT = 4; // front/back/label/detail

/**
 * US-2148 AC5: is the SELLER behind this purchase in a confirmed-counterfeit
 * batch right now? Service-role.
 *
 * This is the ADR's flaw #2 turned into a control. A per-period budget with a
 * loss-ratio breaker "handles correlated bursts worst — the breaker trips AFTER
 * the batch has already drawn down", so the first claims of a batch auto-pay and
 * the rest of that seller's buyers meet an exhausted pool. Holding a claim that
 * belongs to a live batch moves the protection ahead of the drawdown.
 *
 * Four things this deliberately does NOT do:
 *
 *   • It does not touch the fraud score. Those signals are about the CLAIMANT
 *     and are retained on the row for dispute defense; a buyer who bought from a
 *     bad seller is not a suspicious buyer, and filing seller conduct under
 *     `fraud_flags` would say exactly that. Same subject-conflation mistake the
 *     correction on US-2148 exists to prevent.
 *   • It does not reject anything. A held claim goes to a human, who can approve
 *     it. The worst case of a false hold is a wait, which is the trade the ADR
 *     asks for.
 *   • It never fires on a raw model verdict (AC3) — only `reviewer_verdict =
 *     'counterfeit'`, a human outcome.
 *   • It fails OPEN. A seller we cannot resolve, or a failed query, must not
 *     block a payout on a risk signal we did not actually read.
 *
 * The clustering clock is the grade report's `created_at` (when the item was
 * assessed), not the review's `reviewed_at`. A reviewer clearing a week-old
 * backlog in one afternoon would manufacture a batch signature out of our own
 * queue latency; and `created_at` is what the /admin/authenticity console ranks
 * on, so an operator sees the same number that caused the hold.
 */
async function evaluateSellerBatchRisk(
  gradeReportId: string,
  nowMs: number,
): Promise<{ held: boolean; sellerId: string | null; confirmedInWindow: number }> {
  const open = { held: false, sellerId: null, confirmedInWindow: 0 };
  try {
    // The seller behind this purchase. Cross-tenant BY DESIGN: the risk question
    // is about the counterparty, not the claimant. Nothing read here is ever
    // returned to the buyer — see the opaque decision reason at the call site.
    const { data: report, error: repErr } = await supabaseAdmin
      .from("grade_reports")
      .select("submissions!inner(user_id)")
      .eq("id", gradeReportId)
      .maybeSingle();
    if (repErr) throw new Error(repErr.message);
    const sellerId =
      (report as unknown as { submissions?: { user_id?: string | null } } | null)
        ?.submissions?.user_id ?? null;
    if (!sellerId) return open;

    // Bounded by the window, so this stays a small read however long the seller
    // has been on the platform.
    const since = new Date(nowMs - CLUSTER_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: confirmed, error: confErr } = await supabaseAdmin
      .from("grade_reports")
      .select("created_at, submissions!inner(user_id), authenticity_review_outcomes!inner(reviewer_verdict)")
      .eq("submissions.user_id", sellerId)
      .eq("authenticity_review_outcomes.reviewer_verdict", "counterfeit")
      .gte("created_at", since);
    if (confErr) throw new Error(confErr.message);

    const times = ((confirmed ?? []) as unknown as { created_at: string }[])
      .map((r) => Date.parse(r.created_at));
    return { ...correlatedBatchHold(times, nowMs), sellerId };
  } catch (err) {
    // Fail open, but loudly: a risk control that silently stopped evaluating is
    // indistinguishable from one that keeps finding nothing.
    captureException(err, { route: "buyer-guarantee.seller_batch_risk", extra: { gradeReportId } });
    return open;
  }
}

/** Gather + score the fraud signals for a claim (US-1823). Service-role. */
async function evaluateClaimFraud(
  userId: string,
  purchase: OwnedPurchaseForClaim,
  period: string,
): Promise<FraudVerdict> {
  const config = normalizeGuaranteeFraudConfig(
    await getSetting<unknown>(GUARANTEE_FRAUD_SETTING_KEY, DEFAULT_GUARANTEE_FRAUD_CONFIG),
  );

  const [claimsThisPeriodRes, rejectedRes, arrivalRes, trustRes, reportRes] = await Promise.all([
    supabaseAdmin
      .from("buyer_guarantee_claims")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", `${period}-01T00:00:00Z`),
    supabaseAdmin
      .from("buyer_guarantee_claims")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "rejected"),
    supabaseAdmin
      .from("purchase_arrival_captures")
      .select("id", { count: "exact", head: true })
      .eq("purchase_id", purchase.id)
      .eq("user_id", userId),
    supabaseAdmin.from("buyer_trust_scores").select("level").eq("user_id", userId).maybeSingle(),
    supabaseAdmin
      .from("grade_reports")
      .select("image_authenticity")
      .eq("id", purchase.grade_report_id)
      .maybeSingle(),
  ]);

  const auth = (reportRes.data as { image_authenticity?: { manipulation_suspected?: boolean } } | null)
    ?.image_authenticity;

  return evaluateFraudSignals(
    {
      claimsThisPeriod: claimsThisPeriodRes.count ?? 0,
      recentRejectedClaims: rejectedRes.count ?? 0,
      trustLevel: (trustRes.data as { level: number } | null)?.level ?? 0,
      hasFullArrivalEvidence: (arrivalRes.count ?? 0) >= ARRIVAL_TYPE_COUNT,
      gradeAuthenticityFlagged: auth?.manipulation_suspected === true,
    },
    config,
  );
}

// ── admin-tunable economics ─────────────────────────────────────────────────

export interface BuyerGuaranteeRemedyConfig {
  /** Percent of the recorded purchase price the remedy covers. */
  remedy_pct: number;
  /** Remedy when the buyer never recorded a price. */
  flat_remedy_cents: number;
  /** Dollar value (cents) of one granted reward credit. */
  cents_per_credit: number;
  /** Remedies at/under this auto-approve; above → manual review. */
  auto_max_cents: number;
  /** Master switch for automation (false → everything routes to manual review). */
  auto_approve: boolean;
}

export const BUYER_GUARANTEE_REMEDY_SETTING_KEY = "buyer.guarantee_remedy";

export const DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG: BuyerGuaranteeRemedyConfig = {
  remedy_pct: 50,
  flat_remedy_cents: 2500,
  cents_per_credit: 500,
  auto_max_cents: 10000,
  auto_approve: true,
};

function coerceNonNegInt(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 0;
}

export function normalizeBuyerGuaranteeRemedyConfig(raw: unknown): BuyerGuaranteeRemedyConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG;
  return {
    remedy_pct: Math.min(100, coerceNonNegInt(r.remedy_pct, d.remedy_pct)),
    flat_remedy_cents: coerceNonNegInt(r.flat_remedy_cents, d.flat_remedy_cents),
    // A zero here would divide-by-zero the credit math; clamp to the default.
    cents_per_credit: Math.max(1, coerceNonNegInt(r.cents_per_credit, d.cents_per_credit)),
    auto_max_cents: coerceNonNegInt(r.auto_max_cents, d.auto_max_cents),
    auto_approve: typeof r.auto_approve === "boolean" ? r.auto_approve : d.auto_approve,
  };
}

// ── pure decision ───────────────────────────────────────────────────────────

export type ClaimDecision = "auto_approved" | "manual_review" | "rejected";

export interface ClaimEvidence {
  matchStatus: "confirmed" | "disputed" | null;
  disputeSeverity: "cosmetic" | "material" | null;
  guaranteeEligible: boolean;
  overallDelta: number;
  purchasePriceCents: number | null;
}

export interface ClaimCoverage {
  eligible: boolean;
  coveredUntil: string | null;
  payoutCapCents: number;
}

export interface ClaimDecisionResult {
  decision: ClaimDecision;
  remedyCents: number;
  remedyCredits: number;
  reason: string;
}

/**
 * Decide the guarantee remedy for a claim. PURE (nowMs injected). A claim is only
 * payable when the confirm evidence already flagged a MATERIAL, guarantee-eligible
 * mismatch AND the frozen coverage is still eligible + in-window; the remedy is a
 * percent of the price (or a flat fallback) capped by the coverage payout cap, and
 * auto-approves only at/under the auto-max — larger remedies route to a human.
 */
export function decideBuyerGuaranteeRemedy(
  evidence: ClaimEvidence,
  coverage: ClaimCoverage | null,
  config: BuyerGuaranteeRemedyConfig,
  nowMs: number,
): ClaimDecisionResult {
  const nil = { remedyCents: 0, remedyCredits: 0 };

  if (evidence.matchStatus !== "disputed" || evidence.disputeSeverity !== "material") {
    return { decision: "rejected", ...nil, reason: "not_a_material_mismatch" };
  }
  if (!evidence.guaranteeEligible) {
    return { decision: "rejected", ...nil, reason: "not_guarantee_eligible" };
  }
  if (!coverage || !coverage.eligible) {
    return { decision: "rejected", ...nil, reason: "coverage_not_eligible" };
  }
  if (coverage.coveredUntil) {
    const until = Date.parse(coverage.coveredUntil);
    if (Number.isFinite(until) && nowMs > until) {
      return { decision: "rejected", ...nil, reason: "coverage_window_lapsed" };
    }
  }

  const policyCents = evidence.purchasePriceCents != null && evidence.purchasePriceCents > 0
    ? Math.round((evidence.purchasePriceCents * config.remedy_pct) / 100)
    : config.flat_remedy_cents;
  const remedyCents = Math.max(0, Math.min(policyCents, coverage.payoutCapCents));
  const remedyCredits = Math.floor(remedyCents / config.cents_per_credit);

  if (!config.auto_approve || remedyCents > config.auto_max_cents) {
    return { decision: "manual_review", remedyCents, remedyCredits, reason: "over_auto_cap" };
  }
  return { decision: "auto_approved", remedyCents, remedyCredits, reason: "auto_within_cap" };
}

// ── orchestrator (service-role) ─────────────────────────────────────────────

export interface OwnedPurchaseForClaim {
  id: string;
  grade_report_id: string;
  purchase_price_cents: number | null;
}

export interface FileClaimResult {
  ok: boolean;
  status: string;
  remedyCents: number;
  remedyCredits: number;
  reason: string;
  /** false + a reason when the purchase can't produce a claim at all. */
  eligible: boolean;
}

/**
 * File (or return the existing) guarantee claim for an OWNED purchase. Idempotent
 * on purchase_id — a re-file returns the existing claim, never a second payout.
 * Requires the buyer_arrival outcome to be a material mismatch; otherwise returns
 * eligible:false with no row (nothing to review). `nowMs` injected for tests.
 */
export async function fileBuyerGuaranteeClaim(
  userId: string,
  purchase: OwnedPurchaseForClaim,
  nowMs: number = Date.now(),
): Promise<FileClaimResult> {
  // Existing claim? Idempotent — return it.
  const { data: existing } = await supabaseAdmin
    .from("buyer_guarantee_claims")
    .select("status, remedy_cents, remedy_credits, decision_reason")
    .eq("purchase_id", purchase.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) {
    const e = existing as {
      status: string;
      remedy_cents: number;
      remedy_credits: number;
      decision_reason: string | null;
    };
    return {
      ok: true,
      status: e.status,
      remedyCents: e.remedy_cents,
      remedyCredits: e.remedy_credits,
      reason: e.decision_reason ?? "existing",
      eligible: true,
    };
  }

  // The confirm evidence (US-1812) for this purchase.
  const { data: outcome } = await supabaseAdmin
    .from("grade_outcomes")
    .select("match_status, dispute_severity, guarantee_eligible, overall_delta")
    .eq("buyer_purchase_id", purchase.id)
    .eq("buyer_user_id", userId)
    .eq("source", "buyer_arrival")
    .maybeSingle();
  const ev = outcome as {
    match_status: "confirmed" | "disputed" | null;
    dispute_severity: "cosmetic" | "material" | null;
    guarantee_eligible: boolean;
    overall_delta: number | null;
  } | null;
  if (!ev || ev.match_status !== "disputed" || ev.dispute_severity !== "material") {
    return {
      ok: false,
      status: "ineligible",
      remedyCents: 0,
      remedyCredits: 0,
      reason: "no_material_mismatch",
      eligible: false,
    };
  }

  // Frozen coverage snapshot (US-1820).
  const { data: cov } = await supabaseAdmin
    .from("purchase_coverage")
    .select("eligible, covered_until, payout_cap_cents")
    .eq("purchase_id", purchase.id)
    .eq("user_id", userId)
    .maybeSingle();
  const coverage: ClaimCoverage | null = cov
    ? {
      eligible: (cov as { eligible: boolean }).eligible,
      coveredUntil: (cov as { covered_until: string | null }).covered_until,
      payoutCapCents: (cov as { payout_cap_cents: number }).payout_cap_cents ?? 0,
    }
    : null;

  const config = normalizeBuyerGuaranteeRemedyConfig(
    await getSetting<unknown>(BUYER_GUARANTEE_REMEDY_SETTING_KEY, DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG),
  );

  const decision = decideBuyerGuaranteeRemedy(
    {
      matchStatus: ev.match_status,
      disputeSeverity: ev.dispute_severity,
      guaranteeEligible: ev.guarantee_eligible,
      overallDelta: ev.overall_delta ?? 0,
      purchasePriceCents: purchase.purchase_price_cents,
    },
    coverage,
    config,
    nowMs,
  );

  const period = periodKey(nowMs);

  // US-1823: fraud signals — evaluated for EVERY claim (retained on the row for
  // dispute defense); a suspicious claim never auto-pays.
  // US-2148 AC5: the seller-side batch signal, gathered concurrently. Kept as a
  // separate verdict rather than folded into `fraud` because the two are about
  // different people.
  const [fraud, sellerRisk] = await Promise.all([
    evaluateClaimFraud(userId, purchase, period),
    evaluateSellerBatchRisk(purchase.grade_report_id, nowMs),
  ]);

  // US-1822: the claims-pool gate — a would-be auto-payout that breaches the
  // per-account cap, the period budget, or the loss-ratio circuit-breaker is
  // downgraded to manual review (never auto-paid past a cap).
  let finalDecision: ClaimDecision = decision.decision;
  let finalReason = decision.reason;
  if (decision.decision === "auto_approved") {
    if (fraud.suspicious) {
      finalDecision = "manual_review";
      finalReason = `fraud:${fraud.reasons.join(",")}`;
    } else if (sellerRisk.held) {
      // US-2148 AC5. The reason is OPAQUE on purpose: the buyer owns this row and
      // can read it, and "seller_cluster:4" would tell them how many confirmed
      // counterfeits another user has. The count goes to operators as a metric.
      //
      // Ahead of the pool reserve, not after: a held claim must not draw the
      // budget down, which is the whole point of moving the protection earlier.
      finalDecision = "manual_review";
      finalReason = "correlated_batch_review";
      recordMetric("guarantee.seller_batch_hold", sellerRisk.confirmedInWindow, {
        seller_id: sellerRisk.sellerId ?? "unknown",
        purchase_id: purchase.id,
      });
    } else {
      // US-2144: RESERVE rather than read-then-decide. The old sequence read
      // pool state here and recorded the drawdown after the claim insert, so two
      // concurrent claims evaluated against the same pre-drawdown state and
      // could both pass the same budget — the exact correlated-batch case the
      // budget exists to bound. The reserve checks and records atomically.
      //
      // Reserved against the purchase id, not the claim id: the claim row does
      // not exist yet, and the claim itself is idempotent on purchase_id, so
      // this keeps one reservation per purchase through a retry.
      const poolConfig = await getGuaranteePoolConfig();
      const reserve = await reservePoolDrawdown(
        poolDrawdownRef(purchase.id),
        userId,
        decision.remedyCents,
        period,
        poolConfig,
      );
      if (!reserve.allowed) {
        finalDecision = "manual_review";
        finalReason = `pool_${reserve.reason}`;
      }
    }
  }
  const isAuto = finalDecision === "auto_approved";

  // Record the claim (idempotent on purchase_id — a race returns the winner's row).
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("buyer_guarantee_claims")
    .upsert(
      {
        user_id: userId,
        purchase_id: purchase.id,
        grade_report_id: purchase.grade_report_id,
        status: finalDecision,
        grade_delta: ev.overall_delta,
        purchase_price_cents: purchase.purchase_price_cents,
        payout_cap_cents: coverage?.payoutCapCents ?? null,
        remedy_cents: decision.remedyCents,
        remedy_credits: isAuto ? decision.remedyCredits : 0,
        auto: isAuto,
        decision_reason: finalReason,
        fraud_flags: fraud.reasons,
        fraud_score: fraud.score,
      } as never,
      { onConflict: "purchase_id" },
    )
    .select("id, status")
    .single();
  if (insErr) throw new Error(`fileBuyerGuaranteeClaim record failed: ${insErr.message}`);
  const claimId = (inserted as { id: string }).id;

  // Auto-approved → draw down the pool + grant the remedy credits now (both
  // idempotent on the claim id).
  if (isAuto) {
    // US-2291: the pool was ALREADY drawn down by reservePoolDrawdown above, at
    // decision time. This used to call recordPoolDrawdown(claimId, …) as a
    // "no-op-on-conflict" — but the ledger dedupes on (entry_type,
    // reference_id), and the reserve keyed on the PURCHASE while this keyed on
    // the CLAIM. Two different keys, so nothing conflicted and both rows
    // landed: every auto-approved claim drew the pool down twice, and a $5,000
    // period budget was exhausted after $2,500 of real payouts.
    //
    // The fix is removal, not re-keying. The reserve is where the money moves
    // and it is atomic; a second write here could only ever be a duplicate or a
    // no-op, and one of those is expensive. recordPoolDrawdown still exists for
    // the path that genuinely never reserved — a claim a human approves after
    // manual review.
    if (decision.remedyCredits > 0) {
      const { error: grantErr } = await supabaseAdmin.rpc("grant_buyer_reward_credit", {
        p_user_id: userId,
        p_reference_id: `guarantee:${claimId}`,
        p_credits: decision.remedyCredits,
        p_reason: "guarantee_remedy",
      });
      if (grantErr) {
        // US-2144: a swallowed failure here leaves a buyer owed credits nobody
        // knows are missing — the claim row already reads auto_approved with
        // remedy_credits set, and the pool has already been drawn down, so
        // nothing downstream ever revisits it. A bare console.error is not
        // alertable; this makes the discrepancy observable.
        //
        // Deliberately NOT changing the payout semantics here: whether the claim
        // should flip to manual_review, and whether the drawdown should reverse,
        // is a money decision with an owner, recorded in
        // vault/60-decisions/adr-authenticity-guarantee.md. Silently succeeding
        // is wrong either way; silently *undoing* a payout would be worse.
        captureException(grantErr, {
          route: "buyer-guarantee.remedy_grant",
          extra: { claimId, credits: decision.remedyCredits },
        });
        recordMetric("guarantee.remedy_grant_failed", 1, { claim_id: claimId });

        // US-2144, decided 2026-07-19: flip to manual_review and KEEP the
        // drawdown. The buyer is owed credits that did not arrive, and leaving
        // the row reading auto_approved means nothing ever revisits it. Keeping
        // the drawdown reserves the money conservatively — silently UNDOING a
        // payout would be worse than silently succeeding.
        const { error: flipErr } = await supabaseAdmin
          .from("buyer_guarantee_claims")
          .update({
            status: "manual_review",
            auto: false,
            decision_reason: "grant_failed",
          } as never)
          .eq("id", claimId);
        if (flipErr) {
          // Both the grant and the flip failed — the alert above is now the only
          // record, so make that explicit rather than losing it in a log line.
          recordMetric("guarantee.grant_failure_unrecoverable", 1, { claim_id: claimId });
        }
      }
    }
  }

  // Notify the buyer of the outcome (US-1803; best-effort, idempotent).
  const dollars = (decision.remedyCents / 100).toFixed(2);
  await notifyBuyer(userId, {
    category: "guarantee",
    title: isAuto
      ? "Guarantee claim approved"
      : finalDecision === "manual_review"
      ? "Guarantee claim under review"
      : "Guarantee claim received",
    body: isAuto
      ? `Your Grade-Locked claim was approved for $${dollars} — ${decision.remedyCredits} reward credits added.`
      : finalDecision === "manual_review"
      ? "Your Grade-Locked claim is being reviewed by our team. We'll update you shortly."
      : "We reviewed your Grade-Locked claim — see your purchase for details.",
    link: "/buyer/rewards",
    dedupeKey: `guarantee-claim:${claimId}`,
  }).catch(() => {});

  // US-1845: the claim outcome, which is the feature's whole point. The DECISION
  // shape only — no purchase, no seller, no claim id — because this stream is
  // measurement, not the audit trail (buyer_guarantee_claims is that).
  trackBuyerFeature(userId, "guarantee_claims", finalDecision, {
    auto: isAuto,
    remedy_cents: decision.remedyCents,
    remedy_credits: isAuto ? decision.remedyCredits : 0,
  });

  return {
    ok: true,
    status: finalDecision,
    remedyCents: decision.remedyCents,
    remedyCredits: isAuto ? decision.remedyCredits : 0,
    reason: finalReason,
    eligible: true,
  };
}
