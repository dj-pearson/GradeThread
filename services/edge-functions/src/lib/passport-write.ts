// Garment Passport write path (US-1091).
//
// Seeds a SINGLE-HOP passport for a freshly created grade certificate — the
// live-grade counterpart of the 00257 backfill, so the ledger (US-1089) keeps
// growing as new grades land. One call creates:
//   • a pseudonymous origin owner_node ("Seller A", kind=seller — chain pos 0)
//   • a garment (created_by = grading user; sku_class from the submission)
//   • a 'graded' garment_event (confidence='deterministic')
// and links the report back via grade_reports.garment_id.
//
// Idempotent: a no-op if the report already has a garment_id. Best-effort by
// design — the caller wraps it so a passport failure can never fail or slow a
// completed paid grade (the grade + certificate are already persisted).
//
// Tenant-scoping (US-268): garments.created_by is set to the workspace owner;
// the report update is scoped by report id (already owned by the caller).

import { supabaseAdmin } from "./supabase.ts";
import { pseudonymousLabel } from "./garment-passport.ts";
import { buildFingerprintPayload, phashesByType, wearScore } from "./garment-fingerprint.ts";

/** Coarse confidence bucket — mirrors public_grade_reports.confidence_label. */
function confidenceLabel(score: number): string {
  if (score >= 0.9) return "very_high";
  if (score >= 0.75) return "high";
  if (score >= 0.6) return "moderate";
  return "reviewed";
}

export interface SingleHopPassportInput {
  gradeReportId: string;
  /** Workspace owner — the tenant key (garments.created_by). */
  createdByUserId: string;
  /** Brand / type / category descriptor (no tenant keys, no PII). */
  skuClass: Record<string, unknown>;
  overallScore: number;
  gradeTier: string;
  confidenceScore: number;
  /** Public certificate handle — linked from the passport timeline. */
  certificateId: string;
}

/**
 * Create the single-hop passport for a new certificate and link the report to
 * it. Returns the new garment id, or null if it was a no-op / failed (logged;
 * never throws — callers treat this as best-effort).
 */
export async function createSingleHopPassport(
  input: SingleHopPassportInput,
): Promise<string | null> {
  try {
    // Idempotency: skip if this report is already linked to a garment.
    const { data: existing } = await supabaseAdmin
      .from("grade_reports")
      .select("garment_id")
      .eq("id", input.gradeReportId)
      .maybeSingle();
    if (existing && (existing as { garment_id: string | null }).garment_id) {
      return (existing as { garment_id: string }).garment_id;
    }

    // 1. Pseudonymous origin seller node (chain position 0 → "Seller A").
    const { data: node, error: nodeErr } = await supabaseAdmin
      .from("owner_nodes")
      .insert({ pseudonymous_label: pseudonymousLabel("seller", 0), kind: "seller" })
      .select("id")
      .single();
    if (nodeErr || !node) {
      console.error("[passport-write] owner_node insert failed:", nodeErr?.message);
      return null;
    }
    const nodeId = (node as { id: string }).id;

    // 2. The garment identity, owned by the current seller node.
    const { data: garment, error: gErr } = await supabaseAdmin
      .from("garments")
      .insert({
        sku_class: input.skuClass,
        current_owner_node_id: nodeId,
        created_by: input.createdByUserId,
      })
      .select("id")
      .single();
    if (gErr || !garment) {
      console.error("[passport-write] garment insert failed:", gErr?.message);
      return null;
    }
    const garmentId = (garment as { id: string }).id;

    // 3. The deterministic 'graded' event. PII-free payload — `certificate` (not
    //    certificate_id) survives sanitizePayload() for the public link-back.
    const { error: evErr } = await supabaseAdmin.from("garment_events").insert({
      garment_id: garmentId,
      event_type: "graded",
      actor_node_id: nodeId,
      payload: {
        overall_score: input.overallScore,
        grade_tier: input.gradeTier,
        confidence_label: confidenceLabel(input.confidenceScore),
        certificate: input.certificateId,
      },
      confidence: "deterministic",
      source: "grading-pipeline",
    });
    if (evErr) {
      console.error("[passport-write] garment_event insert failed:", evErr.message);
      // Garment exists but event failed — leave the link unset so the backfill
      // (idempotent, garment_id IS NULL) can repair it later.
      return null;
    }

    // 4. Link the report → garment. Scoped by report id (caller-owned).
    const { error: updErr } = await supabaseAdmin
      .from("grade_reports")
      .update({ garment_id: garmentId })
      .eq("id", input.gradeReportId);
    if (updErr) {
      console.error("[passport-write] grade_reports link failed:", updErr.message);
      return null;
    }

    return garmentId;
  } catch (e) {
    console.error("[passport-write] unexpected error:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * US-1124: guarantee a grade_report has its single-hop passport, seeding it from
 * the report + its submission if missing. Idempotent (returns the existing
 * garment_id when already linked) and best-effort (never throws). This is the
 * self-heal primitive: it closes the race/failure window where the grading
 * pipeline's synchronous seed didn't persist a garment_id before a downstream
 * consumer (listing builder, certificate, repair cron) reads it.
 *
 * Only certificated reports get a passport (mirrors the 00257 backfill filter).
 * Tenant-safe: created_by is derived from the report's own submission.user_id —
 * never from a caller-supplied id.
 */
export async function ensurePassportForGradeReport(
  gradeReportId: string,
): Promise<string | null> {
  try {
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "garment_id, submission_id, overall_score, grade_tier, confidence_score, certificate_id",
      )
      .eq("id", gradeReportId)
      .maybeSingle();
    if (!report) return null;
    const r = report as {
      garment_id: string | null;
      submission_id: string | null;
      overall_score: number | null;
      grade_tier: string | null;
      confidence_score: number | null;
      certificate_id: string | null;
    };
    // Already linked — nothing to do (the common, fast path).
    if (r.garment_id) return r.garment_id;
    // No certificate (or orphaned report) → never gets a passport.
    if (!r.certificate_id || !r.submission_id) return null;

    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("user_id, brand, garment_type, garment_category")
      .eq("id", r.submission_id)
      .maybeSingle();
    if (!submission) return null;
    const s = submission as {
      user_id: string | null;
      brand: string | null;
      garment_type: string | null;
      garment_category: string | null;
    };
    if (!s.user_id) return null;

    // createSingleHopPassport re-checks garment_id under the hood, so a concurrent
    // seed loses the race harmlessly (the second call returns the first's id).
    return await createSingleHopPassport({
      gradeReportId,
      createdByUserId: s.user_id,
      skuClass: {
        brand: s.brand ?? undefined,
        garment_type: s.garment_type,
        category: s.garment_category,
      },
      overallScore: Number(r.overall_score ?? 0),
      gradeTier: String(r.grade_tier ?? ""),
      confidenceScore: Number(r.confidence_score ?? 0),
      certificateId: r.certificate_id,
    });
  } catch (e) {
    console.error(
      "[passport-write] ensurePassportForGradeReport failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * US-1124: repair path for certificated grade_reports left with a NULL
 * garment_id by the live-seed race/failure window (the migration backfill only
 * runs once at deploy). Newest-first, bounded; reuses the idempotent
 * ensurePassportForGradeReport per row. Best-effort; returns scan/repair counts.
 */
export async function repairMissingPassports(limit = 200): Promise<{
  scanned: number;
  repaired: number;
}> {
  const { data: rows, error } = await supabaseAdmin
    .from("grade_reports")
    .select("id")
    .not("certificate_id", "is", null)
    .is("garment_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[passport-write] repairMissingPassports query failed:", error.message);
    return { scanned: 0, repaired: 0 };
  }
  const ids = ((rows ?? []) as Array<{ id: string }>).map((row) => row.id);
  let repaired = 0;
  for (const id of ids) {
    const garmentId = await ensurePassportForGradeReport(id);
    if (garmentId) repaired++;
  }
  return { scanned: ids.length, repaired };
}

/**
 * US-1097: store the per-grade visual fingerprint for a garment. Reuses the
 * phash already computed + stored on submission_images (the hardened server-side
 * dHash — no image re-fetch) plus the structured defect map. Idempotent (one
 * fingerprint per grade_report; a re-run's unique-violation is ignored).
 * Best-effort — never throws; a fingerprint failure must not affect the grade.
 */
export async function storeGarmentFingerprint(input: {
  garmentId: string;
  gradeReportId: string;
  images: Array<{ image_type: string; phash: string | null }>;
  defects: Array<{ defect_type?: string | null; location?: string | null }>;
  overallScore: number;
  measurements?: Record<string, number> | null;
}): Promise<void> {
  try {
    const phashes = phashesByType(input.images);
    // Nothing to fingerprint (no hashable photos AND no defects) → skip.
    if (Object.keys(phashes).length === 0 && input.defects.length === 0) return;

    const payload = buildFingerprintPayload({
      phashes,
      defects: input.defects,
      measurements: input.measurements ?? null,
    });

    const { error } = await supabaseAdmin.from("garment_fingerprints").insert({
      garment_id: input.garmentId,
      grade_report_id: input.gradeReportId,
      payload,
      wear_score: wearScore(input.overallScore),
    });
    // 23505 = unique_violation (already fingerprinted this grade) → idempotent.
    if (error && error.code !== "23505") {
      console.error("[passport-write] fingerprint insert failed:", error.message);
    }
  } catch (e) {
    console.error("[passport-write] fingerprint error:", e instanceof Error ? e.message : e);
  }
}
