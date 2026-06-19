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
        "buyer_writeup, defects_found, detected_style_attributes, detailed_notes",
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
