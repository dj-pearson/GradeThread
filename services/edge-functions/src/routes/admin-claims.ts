import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { buildDisclosure, type DefectFound } from "../lib/disclosure.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import {
  applyClaimAccuracySignal,
  neutralizeClaimAccuracySignal,
} from "../lib/accuracy-tracking.ts";
import {
  type ClaimedIssue,
  type CoverageRecord,
  evaluateClaimScope,
  issueGuaranteeRemedy,
  type RemedyContext,
  type RemedyDeps,
} from "../lib/guarantee-remedy.ts";
import { getStripe } from "../lib/stripe-client.ts";
import { sendGuaranteeRemedyEmail } from "../lib/email.ts";
import { callerHasScope, requireScope } from "../lib/scope-guard.ts";
import { requireFreshStepUp } from "../lib/step-up.ts";

// US-867: admin review of buyer trust-guarantee claims. Mounted at
// /api/admin/claims — inherits authMiddleware + adminAuthMiddleware from main.ts
// (/api/admin/*). The browser client can't read guarantee_claims (RLS on, no
// policy — it holds buyer PII), so the admin UI reads through these service-role
// endpoints. Every state change verifies a row was written (updateByIdChecked)
// and writes an attributable audit-log row.
//
// v1 is review-only: a decision flips the status + records a resolution note.
// There is NO automated payout — refunds/remedies are handled off-platform.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminClaimsRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminClaimsRoutes.use("*", requireScope("grading:review"));

const db = supabaseAdmin as unknown as CheckedUpdateClient;

const VALID_STATUS = new Set([
  "submitted",
  "under_review",
  "approved",
  "rejected",
]);

interface ClaimRow {
  id: string;
  certificate_id: string;
  grade_report_id: string;
  // US-1101: the Garment Passport this claim is anchored to (null = pre-passport).
  garment_id: string | null;
  seller_user_id: string;
  claimant_email: string;
  claimant_name: string | null;
  marketplace: string | null;
  order_reference: string | null;
  reason: string;
  claimed_issues: unknown;
  evidence_urls: unknown;
  status: string;
  resolution: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReportRow {
  id: string;
  submission_id: string;
  certificate_id?: string | null;
  overall_score: number;
  grade_tier: string;
  ai_summary: string | null;
  buyer_writeup: string | null;
  defects_found: unknown;
  detected_style_attributes: unknown;
  detailed_notes: unknown;
  // US-1279: documented coverage scope, for the out-of-scope claim flagging.
  coverage?: CoverageRecord | null;
}

function auditLog(
  c: Context,
  action: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  return writeAuditLog(c, { action, targetType: "guarantee_claim", targetId, details });
}

// Build the certified disclosure (the reference a claim is judged against) from
// a grade report row, reusing the deterministic engine that produced it.
function disclosureForReport(report: ReportRow) {
  const notes = (report.detailed_notes ?? null) as
    | { defects_summary?: string | null }
    | null;
  return buildDisclosure({
    overall_score: Number(report.overall_score),
    grade_tier: report.grade_tier,
    defects_found: Array.isArray(report.defects_found)
      ? (report.defects_found as DefectFound[])
      : [],
    detected_style_attributes: Array.isArray(report.detected_style_attributes)
      ? (report.detected_style_attributes as Array<{ attribute: string; location?: string }>)
      : [],
    legacy_defects_summary: notes?.defects_summary ?? null,
    certificate_id: report.certificate_id ? String(report.certificate_id) : null,
  });
}

// Load a claim + its grade report + submission garment metadata. Service-role
// read; the /api/admin/* group already proved the caller is admin/super_admin.
async function loadClaimContext(claimId: string) {
  const { data: claim, error } = await supabaseAdmin
    .from("guarantee_claims")
    .select("*")
    .eq("id", claimId)
    .maybeSingle();
  if (error || !claim) return null;
  return claim as unknown as ClaimRow;
}

// US-1280: issue the grade-fee-back remedy for an APPROVED, in-scope claim.
// Fail-soft — the approval is already committed, so a remedy hiccup is logged for
// operator follow-up and never throws back into the request. Idempotent via the
// guarantee_remedies ledger (claim_id UNIQUE), so a re-approve never double-pays.
async function runGuaranteeRemedy(c: Context<AdminEnv>, claim: ClaimRow): Promise<void> {
  try {
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id, coverage")
      .eq("id", claim.grade_report_id)
      .maybeSingle();
    if (!report) return;
    const r = report as { submission_id: string; coverage: CoverageRecord | null };

    const { data: sub } = await supabaseAdmin
      .from("submissions")
      .select(
        "id, title, garment_category, payment_status, stripe_payment_intent_id, service_tier",
      )
      .eq("id", r.submission_id)
      .maybeSingle();
    if (!sub) return;
    const s = sub as {
      title: string | null;
      garment_category: string | null;
      payment_status: string | null;
      stripe_payment_intent_id: string | null;
      service_tier: string | null;
    };

    const claimedIssues = (Array.isArray(claim.claimed_issues)
      ? claim.claimed_issues
      : []) as ClaimedIssue[];
    const scope = evaluateClaimScope(claimedIssues, r.coverage, s.garment_category ?? "");

    const ctx: RemedyContext = {
      claimId: claim.id,
      gradeReportId: claim.grade_report_id,
      submissionId: r.submission_id,
      sellerUserId: claim.seller_user_id,
      scope,
      payment: {
        paymentStatus: s.payment_status ?? "unpaid",
        stripePaymentIntentId: s.stripe_payment_intent_id,
        serviceTier: s.service_tier ?? "standard",
      },
    };

    const deps: RemedyDeps = {
      claimRemedy: async (cx) => {
        // INSERT ... ON CONFLICT (claim_id) DO NOTHING via PostgREST upsert with
        // ignoreDuplicates: a returned row means WE inserted it (own the remedy);
        // an empty result means a remedy already exists → skip.
        const { data, error } = await supabaseAdmin
          .from("guarantee_remedies")
          .upsert(
            {
              claim_id: cx.claimId,
              grade_report_id: cx.gradeReportId,
              submission_id: cx.submissionId,
              seller_user_id: cx.sellerUserId,
              documented_zones: cx.scope.documentedZones,
            },
            { onConflict: "claim_id", ignoreDuplicates: true },
          )
          .select("id");
        if (error) throw new Error(error.message);
        return (data?.length ?? 0) > 0;
      },
      refundStripe: async (paymentIntentId, claimId) => {
        const stripe = getStripe();
        if (!stripe) throw new Error("Stripe not configured (STRIPE_SECRET_KEY)");
        const refund = await stripe.refunds.create(
          {
            payment_intent: paymentIntentId,
            reason: "requested_by_customer",
            metadata: { guarantee_claim_id: claimId, refund_reason: "grade_accuracy_guarantee" },
          },
          { idempotencyKey: `guarantee-remedy:${claimId}` },
        );
        return { refundId: refund.id, cents: refund.amount ?? 0 };
      },
      grantCredits: async (userId, credits, notes) => {
        const { error } = await supabaseAdmin.rpc("grant_grade_credits", {
          p_user_id: userId,
          p_credits: credits,
          p_reason: "refund",
          p_notes: notes,
        });
        if (error) throw new Error(error.message);
      },
      recordResult: async (claimId, result) => {
        await supabaseAdmin
          .from("guarantee_remedies")
          .update({
            fee_refund_method: result.feeRefundMethod,
            fee_refund_cents: result.feeRefundCents,
            fee_refund_credits: result.feeRefundCredits,
            regrade_credits: result.regradeCredits,
            stripe_refund_id: result.stripeRefundId,
          })
          .eq("claim_id", claimId);
      },
    };

    const result = await issueGuaranteeRemedy(ctx, deps);
    if (!result.issued) return;

    const emailData = {
      itemTitle: s.title ?? "your graded item",
      feeRefundMethod: result.feeRefundMethod,
      feeRefundCents: result.feeRefundCents,
      feeRefundCredits: result.feeRefundCredits,
      regradeCredits: result.regradeCredits,
    };
    if (claim.claimant_email) {
      await sendGuaranteeRemedyEmail(claim.claimant_email, "buyer", emailData).catch(() => {});
    }
    const { data: seller } = await supabaseAdmin
      .from("users")
      .select("email")
      .eq("id", claim.seller_user_id)
      .maybeSingle();
    const sellerEmail = (seller as { email?: string } | null)?.email;
    if (sellerEmail) {
      await sendGuaranteeRemedyEmail(sellerEmail, "seller", emailData).catch(() => {});
    }

    await auditLog(c, "guarantee_remedy_issued", claim.id, {
      fee_refund_method: result.feeRefundMethod,
      fee_refund_cents: result.feeRefundCents,
      fee_refund_credits: result.feeRefundCredits,
      regrade_credits: result.regradeCredits,
      stripe_refund_id: result.stripeRefundId,
    });
  } catch (err) {
    console.error("[admin-claims] guarantee remedy failed:", err);
  }
}

// ── GET / ─────────────────────────────────────────────────────────
// List claims (optional ?status=) newest first, enriched with the certified
// disclosure + grade + garment metadata so the reviewer can judge the claim
// against what was actually certified.
adminClaimsRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  let q = supabaseAdmin
    .from("guarantee_claims")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (status && VALID_STATUS.has(status)) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    console.error("[admin-claims] list failed:", error.message);
    return c.json({ error: "Failed to load claims" }, 500);
  }
  const claims = (data ?? []) as unknown as ClaimRow[];
  if (claims.length === 0) return c.json({ claims: [] });

  // Hydrate the referenced grade reports + submissions in two batched queries.
  const reportIds = [...new Set(claims.map((cl) => cl.grade_report_id))];
  const { data: reportsData } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "id, submission_id, certificate_id, overall_score, grade_tier, ai_summary, " +
        "buyer_writeup, defects_found, detected_style_attributes, detailed_notes, coverage",
    )
    .in("id", reportIds);
  const reports = (reportsData ?? []) as unknown as (ReportRow & { certificate_id: string })[];
  const reportById = new Map<string, ReportRow & { certificate_id: string }>();
  for (const r of reports) reportById.set(r.id, r);

  const submissionIds = [...new Set(reports.map((r) => r.submission_id))];
  const { data: subsData } = submissionIds.length
    ? await supabaseAdmin
        .from("submissions")
        .select("id, title, brand, garment_type, garment_category")
        .in("id", submissionIds)
    : { data: [] };
  const subById = new Map<string, Record<string, unknown>>();
  for (const s of (subsData ?? []) as Array<Record<string, unknown>>) {
    subById.set(s.id as string, s);
  }

  // US-1101: resolve the Garment Passport slug for chain-linked claims so the
  // reviewer can open the full provenance chain (not just the one-off cert).
  const garmentIds = [
    ...new Set(claims.map((cl) => cl.garment_id).filter((x): x is string => !!x)),
  ];
  const slugByGarment = new Map<string, string>();
  if (garmentIds.length) {
    const { data: garments } = await supabaseAdmin
      .from("garments")
      .select("id, public_passport_slug")
      .in("id", garmentIds);
    for (const g of (garments ?? []) as Array<{ id: string; public_passport_slug: string }>) {
      slugByGarment.set(g.id, g.public_passport_slug);
    }
  }

  const enriched = claims.map((cl) => {
    const report = reportById.get(cl.grade_report_id);
    const submission = report ? subById.get(report.submission_id) : undefined;
    // US-1279 AC2: line the buyer's claimed defect zones up against the
    // documented coverage scope so the reviewer immediately sees which claims
    // fall on a NOT-DOCUMENTED zone (OUT OF SCOPE — the grade never covered it,
    // so no remedy is owed) vs a documented one (in-scope → eligible remedy).
    const scope = evaluateClaimScope(
      Array.isArray(cl.claimed_issues) ? (cl.claimed_issues as ClaimedIssue[]) : [],
      report?.coverage ?? null,
      (submission?.garment_category as string | undefined) ?? "",
    );
    return {
      claim: cl,
      grade: report
        ? {
            overall_score: report.overall_score,
            grade_tier: report.grade_tier,
            ai_summary: report.ai_summary,
            buyer_writeup: report.buyer_writeup,
          }
        : null,
      // US-1279 AC2: { inScope, fullyCovered, documentedZones, undocumentedZones,
      // hasCoverage } — the coverage-gated scope of this claim.
      coverage_scope: scope,
      disclosure: report ? disclosureForReport(report) : null,
      garment: submission
        ? {
            title: submission.title ?? null,
            brand: submission.brand ?? null,
            garment_type: submission.garment_type ?? null,
            garment_category: submission.garment_category ?? null,
          }
        : null,
      // US-1101: the passport this claim is anchored to (null = pre-passport).
      passport_slug: cl.garment_id ? slugByGarment.get(cl.garment_id) ?? null : null,
    };
  });

  return c.json({ claims: enriched });
});

// ── POST /:id/under-review ────────────────────────────────────────
adminClaimsRoutes.post("/:id/under-review", async (c) => {
  const claimId = c.req.param("id");
  const claim = await loadClaimContext(claimId);
  if (!claim) return c.json({ error: "Claim not found" }, 404);

  try {
    await updateByIdChecked(db, "guarantee_claims", claimId, {
      status: "under_review",
      reviewed_by: c.get("userId"),
    });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Claim could not be updated (no row changed)" }, 409);
    }
    console.error("[admin-claims] under-review failed:", err);
    return c.json({ error: "Failed to update claim" }, 500);
  }

  await auditLog(c, "guarantee_claim_under_review", claimId, {
    certificate_id: claim.certificate_id,
    grade_report_id: claim.grade_report_id,
  });
  return c.json({ ok: true });
});

// ── POST /:id/approve and /:id/reject ─────────────────────────────
// Both record a manual decision + resolution note. No payout in v1.
function decisionHandler(decision: "approved" | "rejected", action: string) {
  return async (c: Context<AdminEnv>) => {
    // US-2353 AC2 + AC4: approving a claim REFUNDS the grading fee and grants a
    // free re-grade. Two things were wrong at once and only together do they
    // explain the hole.
    //
    // AC2: no step-up at all, on a route that moves money.
    //
    // AC4, the worse half: the router-wide scope here is grading:review, so
    // revoking an admin's billing:write did NOT stop them paying claims. A scope
    // that can be routed around by choosing a different router is not a scope —
    // it is a label. The billing scope is now required at the route, on top of
    // the router's, because the action belongs to both.
    // Asked through callerHasScope rather than by invoking requireScope as
    // middleware inside a handler — the middleware wants a `next`, and faking
    // one to borrow its check is the kind of cleverness that breaks quietly
    // when the middleware grows a second responsibility.
    const hasBilling = await callerHasScope(
      c.get("adminRole"),
      c.get("userId") ?? null,
      "billing:write",
    );
    if (!hasBilling) {
      return c.json({
        error:
          "Deciding a guarantee claim moves money and requires the billing:write permission.",
        code: "SCOPE_REQUIRED",
        scope: "billing:write",
      }, 403);
    }
    const stepUp = requireFreshStepUp(c);
    if (stepUp) return stepUp;
    const claimId = c.req.param("id");

    let body: { resolution?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const resolution =
      typeof body.resolution === "string" ? body.resolution.trim().slice(0, 4000) : "";
    if (!resolution) {
      return c.json({ error: "A resolution note is required" }, 400);
    }

    const claim = await loadClaimContext(claimId);
    if (!claim) return c.json({ error: "Claim not found" }, 404);

    try {
      await updateByIdChecked(db, "guarantee_claims", claimId, {
        status: decision,
        resolution,
        reviewed_by: c.get("userId"),
        reviewed_at: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof ZeroRowsAffectedError) {
        return c.json({ error: "Claim could not be updated (no row changed)" }, 409);
      }
      console.error(`[admin-claims] ${decision} failed:`, err);
      return c.json({ error: "Failed to update claim" }, 500);
    }

    // US-1113: close the grading-accuracy feedback loop. An APPROVED claim is a
    // confirmed "the grade was wrong" signal → write its per-factor over-grade
    // delta into the accuracy-tracking pipeline; a REJECTION (incl. reversing a
    // prior approval) neutralizes it so it stops feeding calibration. Both are
    // fail-soft and tenant-scoped (signal copies the verified seller_user_id),
    // and run AFTER the decision is committed so they never block it.
    if (decision === "approved" && claim.grade_report_id) {
      await applyClaimAccuracySignal({
        id: claim.id,
        grade_report_id: claim.grade_report_id,
        seller_user_id: claim.seller_user_id,
        claimed_issues: claim.claimed_issues,
      });
      // US-1280: a coverage-gated remedy when the approved claim falls within the
      // documented scope — refund the grading fee + grant a free re-grade. Out-of-
      // scope claims (defect in a zone the photos never showed) get no remedy.
      // Idempotent + fail-soft; runs AFTER the decision commits.
      await runGuaranteeRemedy(c, claim);
    } else if (decision === "rejected") {
      await neutralizeClaimAccuracySignal(claimId);
    }

    await auditLog(c, action, claimId, {
      certificate_id: claim.certificate_id,
      grade_report_id: claim.grade_report_id,
      resolution,
    });
    return c.json({ ok: true });
  };
}

adminClaimsRoutes.post("/:id/approve", decisionHandler("approved", "guarantee_claim_approved"));
adminClaimsRoutes.post("/:id/reject", decisionHandler("rejected", "guarantee_claim_rejected"));
