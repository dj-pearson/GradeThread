import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requiresSuperAdmin } from "../lib/grade-adjust-rules.ts";
import {
  clampScore,
  computeWeightedOverall,
  type FactorScores,
} from "../lib/human-review.ts";
import { applyGradeAdjustment } from "../lib/grade-adjustment.ts";
import { purgeCertificateCache } from "../lib/cloudflare-purge.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";

// Admin dispute resolution (US-474). Mounted at /api/admin/disputes — inherits
// authMiddleware + adminAuthMiddleware from main.ts (/api/admin/*).
//
// WHY THIS EXISTS: the dispute UI (src/pages/admin/disputes.tsx) used to mutate
// grade_reports, disputes, and submissions with the BROWSER Supabase client.
// None of those tables has an admin/reviewer UPDATE policy, so every write
// no-oped under RLS while the UI reported success — grade corrections, status
// changes, and submission reopen/close were all silently dropped. These
// service-role handlers do the writes for real, verify each one changed a row
// (updateByIdChecked), and reseal the certificate hash on a grade adjustment so
// a human-corrected certificate keeps verifying as authentic (US-475).

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminDisputesRoutes = new Hono<AdminEnv>();

const db = supabaseAdmin as unknown as CheckedUpdateClient;

const FACTOR_KEYS: (keyof FactorScores)[] = [
  "fabric_condition_score",
  "structural_integrity_score",
  "cosmetic_appearance_score",
  "functional_elements_score",
  "odor_cleanliness_score",
];

function auditLog(
  c: Context,
  action: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  return writeAuditLog(c, { action, targetType: "dispute", targetId, details });
}

// Load a dispute + its grade report + submission. Service-role read; the
// /api/admin/* group already proved the caller is an admin/super_admin.
async function loadDisputeContext(disputeId: string) {
  const { data: dispute, error } = await supabaseAdmin
    .from("disputes")
    .select("id, user_id, grade_report_id, status, resolution_notes")
    .eq("id", disputeId)
    .maybeSingle();
  if (error || !dispute) return null;
  const d = dispute as unknown as {
    id: string;
    user_id: string;
    grade_report_id: string;
    status: string;
    resolution_notes: string | null;
  };

  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "id, submission_id, overall_score, grade_tier, ai_summary, buyer_writeup, certificate_id, " +
        "fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, " +
        "functional_elements_score, odor_cleanliness_score, coverage",
    )
    .eq("id", d.grade_report_id)
    .maybeSingle();
  if (!report) return null;
  const r = report as unknown as {
    id: string;
    submission_id: string;
    overall_score: number;
    grade_tier: string;
    ai_summary: string;
    buyer_writeup: string | null;
    certificate_id: string | null;
    // US-1279: the documented coverage scope — carried into a reseal so the
    // integrity-v3 hash matches, and used to flag out-of-scope guarantee claims.
    coverage: {
      coverage_pct?: number | null;
      covered_zones?: string[] | null;
      missing_zones?: string[] | null;
      applicable_zones?: string[] | null;
    } | null;
  };

  return { dispute: d, report: r };
}

// POST /:id/under-review — triage flip (open → under_review).
adminDisputesRoutes.post("/:id/under-review", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const disputeId = c.req.param("id");

  const ctx = await loadDisputeContext(disputeId);
  if (!ctx) return c.json({ error: "Dispute not found" }, 404);

  try {
    await updateByIdChecked(db, "disputes", disputeId, { status: "under_review" });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Dispute could not be updated (no row changed)" }, 409);
    }
    console.error("[admin-disputes] under-review update failed:", err);
    return c.json({ error: "Failed to update dispute" }, 500);
  }

  await auditLog(c, "dispute_under_review", disputeId, {
    submission_id: ctx.report.submission_id,
    grade_report_id: ctx.report.id,
  });
  return c.json({ ok: true });
});

// POST /:id/resolve — resolve the dispute, optionally adjusting the grade.
// Body: { notes: string, adjustGrade?: boolean, factors?: FactorScores }
adminDisputesRoutes.post("/:id/resolve", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const adminId = c.get("userId");
  const disputeId = c.req.param("id");

  let body: {
    notes?: unknown;
    adjustGrade?: unknown;
    factors?: Partial<Record<keyof FactorScores, unknown>>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : "";
  if (!notes) {
    return c.json({ error: "Resolution notes are required" }, 400);
  }
  const adjustGrade = body.adjustGrade === true;

  const ctx = await loadDisputeContext(disputeId);
  if (!ctx) return c.json({ error: "Dispute not found" }, 404);
  const { dispute, report } = ctx;

  // Parse + validate the corrected factor scores when adjusting.
  let factors: FactorScores | null = null;
  if (adjustGrade) {
    const f = body.factors ?? {};
    const parsed = {} as FactorScores;
    for (const k of FACTOR_KEYS) {
      const n = Number(f[k]);
      if (!Number.isFinite(n)) return c.json({ error: `Missing/invalid score: ${k}` }, 400);
      parsed[k] = clampScore(n);
    }
    factors = parsed;
  }

  let newOverall = report.overall_score;
  let resealed = false;

  if (adjustGrade && factors) {
    const projectedOverall = computeWeightedOverall(factors);

    // US-478 parity: a swing > 1.5 points requires a super_admin, enforced
    // server-side so a direct API call can't bypass it.
    if (
      requiresSuperAdmin(report.overall_score, projectedOverall) &&
      c.get("adminRole") !== "super_admin"
    ) {
      return c.json(
        {
          error: "A grade change greater than 1.5 points requires super-admin approval.",
          code: "SUPER_ADMIN_REQUIRED",
        },
        403,
      );
    }

    // Record the original AI grade + corrections for the self-improvement
    // dataset (training signal), exactly like the review-queue adjust path.
    const { error: revErr } = await supabaseAdmin.from("human_reviews").insert({
      grade_report_id: report.id,
      reviewer_id: adminId,
      original_score: report.overall_score,
      adjusted_score: projectedOverall,
      adjusted_fabric_condition: factors.fabric_condition_score,
      adjusted_structural_integrity: factors.structural_integrity_score,
      adjusted_cosmetic_appearance: factors.cosmetic_appearance_score,
      adjusted_functional_elements: factors.functional_elements_score,
      adjusted_odor_cleanliness: factors.odor_cleanliness_score,
      review_notes: `Dispute resolution: ${notes}`,
    });
    if (revErr) {
      console.error("[admin-disputes] resolve: human_reviews insert failed:", revErr);
      return c.json({ error: "Failed to record review" }, 500);
    }

    try {
      const result = await applyGradeAdjustment(db, report, factors);
      newOverall = result.overall_score;
      resealed = result.resealed;
    } catch (err) {
      if (err instanceof ZeroRowsAffectedError) {
        return c.json({ error: "Grade report could not be updated (no row changed)" }, 409);
      }
      console.error("[admin-disputes] resolve: grade adjust failed:", err);
      return c.json({ error: "Failed to update grade" }, 500);
    }
  }

  // Resolve the dispute + close the submission. Both verify a row changed.
  try {
    await updateByIdChecked(db, "disputes", disputeId, {
      status: "resolved",
      resolution_notes: notes,
    });
    await updateByIdChecked(db, "submissions", report.submission_id, {
      status: "completed",
    });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Dispute could not be resolved (no row changed)" }, 409);
    }
    console.error("[admin-disputes] resolve: status update failed:", err);
    return c.json({ error: "Failed to resolve dispute" }, 500);
  }

  // US-577: a grade change makes the public certificate's edge-cached SSR page +
  // share images stale — purge them so buyers/crawlers see the new score now.
  if (adjustGrade && report.certificate_id) {
    purgeCertificateCache(report.certificate_id).catch((e) =>
      console.warn("[admin-disputes] cert cache purge failed:", e),
    );
  }

  await auditLog(c, "dispute_resolved", disputeId, {
    submission_id: report.submission_id,
    grade_report_id: report.id,
    grade_adjusted: adjustGrade,
    original_score: report.overall_score,
    new_score: newOverall,
    resealed,
    resolution_notes: notes,
  });

  return c.json({
    ok: true,
    grade_adjusted: adjustGrade,
    overall_score: newOverall,
    resealed,
    user_id: dispute.user_id,
  });
});

// POST /:id/reject — reject the dispute (keep the original grade), reopen→close
// the submission back to completed.
adminDisputesRoutes.post("/:id/reject", async (c) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;
  const disputeId = c.req.param("id");

  let body: { reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
  if (!reason) return c.json({ error: "Rejection reason is required" }, 400);

  const ctx = await loadDisputeContext(disputeId);
  if (!ctx) return c.json({ error: "Dispute not found" }, 404);
  const { report } = ctx;

  try {
    await updateByIdChecked(db, "disputes", disputeId, {
      status: "rejected",
      resolution_notes: reason,
    });
    await updateByIdChecked(db, "submissions", report.submission_id, {
      status: "completed",
    });
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Dispute could not be rejected (no row changed)" }, 409);
    }
    console.error("[admin-disputes] reject: update failed:", err);
    return c.json({ error: "Failed to reject dispute" }, 500);
  }

  await auditLog(c, "dispute_rejected", disputeId, {
    submission_id: report.submission_id,
    grade_report_id: report.id,
    rejection_reason: reason,
  });
  return c.json({ ok: true });
});
