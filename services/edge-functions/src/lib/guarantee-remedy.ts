// US-1279/US-1280: the coverage-gated Grade Accuracy Guarantee remedy.
//
// When an admin APPROVES a guarantee claim (guarantee_claims, US-867) AND the
// claimed defect sits in a zone the certificate documented (coverage scope,
// sealed into the cert-integrity hash at v3, US-1279), GradeThread makes it
// right by refunding the GRADING FEE the seller paid (Stripe refund or a
// credit-back) and granting a free re-grade credit — never by refunding item
// value or shipping. A claim whose defect is in a zone the photos never showed
// is OUT OF SCOPE: the grade never covered it, so no remedy is owed.
//
// This module is split into a PURE scope evaluator (shared by the dispute/claim
// review surface, US-1279 AC2) and a dependency-injected orchestrator (the
// money side, US-1280) so both are unit-testable without a DB/Stripe.

import { inspectionTemplate, zonesFromHint } from "./coverage.ts";

export interface ClaimedIssue {
  defect?: string;
  severity?: string;
  location?: string | null;
}

export interface CoverageRecord {
  garment_category?: string;
  applicable_zones?: string[];
  covered_zones?: string[];
  coverage_pct?: number;
}

export interface ClaimScope {
  /** A coverage record exists with a non-empty applicable-zone set. */
  hasCoverage: boolean;
  /** Every applicable inspection zone was documented (whole garment shown). */
  fullyCovered: boolean;
  /** The claim is within the documented scope, so a remedy may be owed. */
  inScope: boolean;
  /** Claimed-issue zones that ARE documented (the in-scope proof). */
  documentedZones: string[];
  /** Claimed-issue zones that are NOT documented (out of scope). */
  undocumentedZones: string[];
}

/**
 * Map each claimed issue's free-text `location` onto the garment's inspection
 * zones and partition them into documented (covered) vs not. PURE — no I/O.
 *
 * In-scope when the whole garment was documented (so any defect is covered) OR
 * at least one claimed issue maps to a covered zone. A claim whose locations map
 * ONLY to undocumented zones — or to no recognizable zone at all — is out of
 * scope: we never owe a remedy for an area the photos never showed.
 */
export function evaluateClaimScope(
  claimedIssues: ClaimedIssue[] | null | undefined,
  coverage: CoverageRecord | null | undefined,
  garmentCategory: string,
): ClaimScope {
  const applicable = new Set<string>(
    coverage?.applicable_zones && coverage.applicable_zones.length > 0
      ? coverage.applicable_zones
      : inspectionTemplate(garmentCategory).map((z) => z.id),
  );
  const covered = new Set<string>(
    (coverage?.covered_zones ?? []).filter((z) => applicable.has(z)),
  );
  // A coverage RECORD must exist (with applicable zones) to prove scope. A grade
  // with no coverage (pre-00308) can't be in-scope — the guarantee is a forward
  // promise that only applies where the documented scope was sealed.
  const hasCoverage = Boolean(coverage) &&
    (coverage?.applicable_zones?.length ?? 0) > 0;
  const fullyCovered = hasCoverage && covered.size === applicable.size;

  const documented = new Set<string>();
  const undocumented = new Set<string>();
  for (const issue of claimedIssues ?? []) {
    const loc = typeof issue?.location === "string" ? issue.location : "";
    if (!loc) continue;
    for (const zone of zonesFromHint(loc).filter((z) => applicable.has(z))) {
      if (covered.has(zone)) documented.add(zone);
      else undocumented.add(zone);
    }
  }

  const inScope = hasCoverage && (fullyCovered || documented.size > 0);

  return {
    hasCoverage,
    fullyCovered,
    inScope,
    documentedZones: [...documented].sort(),
    undocumentedZones: [...undocumented].sort(),
  };
}

// ── Remedy orchestration (US-1280) ──────────────────────────────────────────

/** Credit-equivalent cost of each grade tier (1 credit = 1 Standard grade). */
const TIER_CREDIT_COST: Record<string, number> = {
  standard: 1,
  premium: 3,
  express: 5,
};
/** The free re-grade credit granted on top of the fee refund. */
export const FREE_REGRADE_CREDITS = 1;

export interface RemedyContext {
  claimId: string;
  gradeReportId: string;
  submissionId: string;
  sellerUserId: string;
  scope: ClaimScope;
  payment: {
    /** 'paid_stripe' | 'credits' | 'included' | 'unpaid' */
    paymentStatus: string;
    stripePaymentIntentId: string | null;
    /** 'standard' | 'premium' | 'express' */
    serviceTier: string;
  };
}

export interface RemedyResult {
  issued: boolean;
  reason?: "out_of_scope" | "already_issued";
  feeRefundMethod: "stripe" | "credit" | "none";
  feeRefundCents: number;
  feeRefundCredits: number;
  regradeCredits: number;
  stripeRefundId: string | null;
}

export interface RemedyDeps {
  /**
   * Atomically claim the remedy: INSERT ... ON CONFLICT (claim_id) DO NOTHING.
   * Returns true if WE own it (newly inserted), false if a remedy already exists
   * for this claim — the idempotency gate that runs BEFORE any money moves, so a
   * double-approve / retry can never issue a second refund or re-grant credits.
   */
  claimRemedy(ctx: RemedyContext): Promise<boolean>;
  /** Reverse the grading-fee card charge (idempotency-keyed on the claim). */
  refundStripe(
    paymentIntentId: string,
    claimId: string,
  ): Promise<{ refundId: string; cents: number }>;
  /** Grant credits to the seller (grant_grade_credits, reason 'refund'). */
  grantCredits(userId: string, credits: number, notes: string): Promise<void>;
  /** Persist the executed amounts onto the claimed ledger row. */
  recordResult(claimId: string, result: RemedyResult): Promise<void>;
}

const NO_REMEDY: Omit<RemedyResult, "reason"> = {
  issued: false,
  feeRefundMethod: "none",
  feeRefundCents: 0,
  feeRefundCredits: 0,
  regradeCredits: 0,
  stripeRefundId: null,
};

/**
 * Issue (or decline) the remedy for an approved guarantee claim. Idempotent: the
 * ledger gate (`claimRemedy`) ensures exactly one remedy per claim. Refunds the
 * grading fee (Stripe OR credit-back, capped at what was actually paid) and
 * grants a free re-grade credit; never touches item value or shipping.
 */
export async function issueGuaranteeRemedy(
  ctx: RemedyContext,
  deps: RemedyDeps,
): Promise<RemedyResult> {
  // Coverage-gated: an out-of-scope claim earns no remedy (no ledger row, no
  // money). The admin's approval still stands as a manual decision/note.
  if (!ctx.scope.inScope) return { ...NO_REMEDY, reason: "out_of_scope" };

  // Idempotency gate — claim ownership before moving any money.
  const owned = await deps.claimRemedy(ctx);
  if (!owned) return { ...NO_REMEDY, reason: "already_issued" };

  // 1) Refund the grading fee by the same rail it was paid on.
  let feeRefundMethod: RemedyResult["feeRefundMethod"] = "none";
  let feeRefundCents = 0;
  let feeRefundCredits = 0;
  let stripeRefundId: string | null = null;

  if (
    ctx.payment.paymentStatus === "paid_stripe" &&
    ctx.payment.stripePaymentIntentId
  ) {
    const r = await deps.refundStripe(ctx.payment.stripePaymentIntentId, ctx.claimId);
    feeRefundMethod = "stripe";
    feeRefundCents = r.cents;
    stripeRefundId = r.refundId;
  } else if (ctx.payment.paymentStatus === "credits") {
    feeRefundCredits = TIER_CREDIT_COST[ctx.payment.serviceTier] ?? 1;
    if (feeRefundCredits > 0) {
      await deps.grantCredits(
        ctx.sellerUserId,
        feeRefundCredits,
        `Grade Accuracy Guarantee: grading-fee credit-back (claim ${ctx.claimId})`,
      );
      feeRefundMethod = "credit";
    }
  }
  // 'included' / 'unpaid' → nothing was charged → only the re-grade credit below.

  // 2) Grant the free re-grade credit so the seller can re-submit at no cost.
  await deps.grantCredits(
    ctx.sellerUserId,
    FREE_REGRADE_CREDITS,
    `Grade Accuracy Guarantee: free re-grade (claim ${ctx.claimId})`,
  );

  const result: RemedyResult = {
    issued: true,
    feeRefundMethod,
    feeRefundCents,
    feeRefundCredits,
    regradeCredits: FREE_REGRADE_CREDITS,
    stripeRefundId,
  };
  await deps.recordResult(ctx.claimId, result);
  return result;
}
