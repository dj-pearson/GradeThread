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
import {
  buildFingerprintedEventPayload,
  buildFingerprintPayload,
  phashesByType,
  wearScore,
} from "./garment-fingerprint.ts";

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
    //    US-1125: link the node to the grading account (uuid linkage only — no
    //    PII). This stays pseudonymous by default: a reveal is the AND of the
    //    per-hop `identity_revealed` consent (false here) AND a live public
    //    verified profile (effectiveRevealedIdentity), so setting linked_user_id
    //    alone leaks nothing — it only lets a seller who LATER reveals identity
    //    surface their Verified badge at the passport origin. Mirrors the buyer
    //    node in transferToNewBuyer.
    const { data: node, error: nodeErr } = await supabaseAdmin
      .from("owner_nodes")
      .insert({
        pseudonymous_label: pseudonymousLabel("seller", 0),
        kind: "seller",
        linked_user_id: input.createdByUserId,
      })
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
 * US-1282: append a RE-GRADE to an existing garment's passport instead of
 * minting a new one. A re-grade is an ordinary, billable grade (it reuses the
 * grading pipeline) of a physical garment we already passported — months later,
 * after wear, or by a new owner — so its condition history accumulates on ONE
 * garment identity and the public passport can render a condition-over-time
 * curve (the "Carfax for clothing").
 *
 * This links the new grade_report to the existing garment and APPENDS a
 * deterministic 'graded' event to its append-only ledger, with the garment's
 * CURRENT owner node as the actor (the party who re-graded it). Idempotent (a
 * no-op if the report is already linked) and best-effort (never throws).
 *
 * Tenant-scoping (US-268): the garment is re-fetched scoped by created_by ==
 * createdByUserId — a forged/foreign regrade_of_garment_id resolves to no row
 * and falls back to a fresh passport (handled by the caller). The report id is
 * caller-owned (the pipeline produced it for this submission).
 */
export async function appendRegradeEvent(
  input: SingleHopPassportInput & { garmentId: string },
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

    // US-268: the garment must belong to this workspace owner. A non-owned id
    // resolves to no row → null (the caller mints a fresh passport instead).
    const { data: garment } = await supabaseAdmin
      .from("garments")
      .select("id, current_owner_node_id")
      .eq("id", input.garmentId)
      .eq("created_by", input.createdByUserId)
      .maybeSingle();
    if (!garment) return null;
    const g = garment as { id: string; current_owner_node_id: string | null };

    // Append the deterministic 'graded' event. PII-free payload mirrors the
    // single-hop seed (the public passport reads per-factor scores from the
    // public_grade_reports view; the event carries only the headline + cert link).
    const { error: evErr } = await supabaseAdmin.from("garment_events").insert({
      garment_id: g.id,
      event_type: "graded",
      actor_node_id: g.current_owner_node_id,
      payload: {
        overall_score: input.overallScore,
        grade_tier: input.gradeTier,
        confidence_label: confidenceLabel(input.confidenceScore),
        certificate: input.certificateId,
        regrade: true,
      },
      confidence: "deterministic",
      source: "grading-pipeline",
    });
    if (evErr) {
      console.error("[passport-write] regrade event insert failed:", evErr.message);
      return null;
    }

    // Link the report → the existing garment (scoped by report id, caller-owned).
    const { error: updErr } = await supabaseAdmin
      .from("grade_reports")
      .update({ garment_id: g.id })
      .eq("id", input.gradeReportId);
    if (updErr) {
      console.error("[passport-write] regrade link failed:", updErr.message);
      return null;
    }

    return g.id;
  } catch (e) {
    console.error(
      "[passport-write] appendRegradeEvent failed:",
      e instanceof Error ? e.message : e,
    );
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
      return;
    }
    // US-1137: emit the deterministic 'fingerprinted' garment_event so the enum
    // value is actually written by its pipeline (the fingerprint service) and the
    // public passport timeline shows when a tamper-evident visual signature was
    // recorded. Only on a FRESH insert (error == null) — an idempotent 23505
    // re-run must not append a duplicate event. Payload is aggregate-only +
    // PII-free; best-effort (a logging failure never affects the grade).
    if (!error) {
      await emitFingerprintedEvent(input.garmentId, {
        phashes,
        defectCount: input.defects.length,
        overallScore: input.overallScore,
      });
    }
  } catch (e) {
    console.error("[passport-write] fingerprint error:", e instanceof Error ? e.message : e);
  }
}

/**
 * US-1137: append the 'fingerprinted' event for a just-stored fingerprint. The
 * actor is the garment's current owner node (the party whose grade produced the
 * fingerprint). Best-effort — never throws; a passport event failure must not
 * affect the grade. Tenant-safe: the garment id is already owner-verified by the
 * grading pipeline that produced it; the lookup is scoped by that id.
 */
async function emitFingerprintedEvent(
  garmentId: string,
  input: { phashes: Record<string, string>; defectCount: number; overallScore: number },
): Promise<void> {
  try {
    const { data: garment } = await supabaseAdmin
      .from("garments")
      .select("current_owner_node_id")
      .eq("id", garmentId)
      .maybeSingle();
    const actorNodeId = (garment as { current_owner_node_id: string | null } | null)
      ?.current_owner_node_id ?? null;

    const { error } = await supabaseAdmin.from("garment_events").insert({
      garment_id: garmentId,
      event_type: "fingerprinted",
      actor_node_id: actorNodeId,
      payload: buildFingerprintedEventPayload(input),
      confidence: "deterministic",
      source: "fingerprint-service",
    });
    if (error) {
      console.error("[passport-write] fingerprinted event insert failed:", error.message);
    }
  } catch (e) {
    console.error(
      "[passport-write] fingerprinted event error:",
      e instanceof Error ? e.message : e,
    );
  }
}
