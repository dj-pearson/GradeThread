// US-2774: persist how an identification was arrived at.
//
// Two decisions were already computed correctly on every run and then thrown
// away. decideCategory returns the METHOD it used, the support behind a visual
// vote and the reason a vote lost; the route logged that to stdout. The model
// returns a verdict on every visual candidate; only the accepted half acted on
// anything. Both are the answer to "why is this wrong", and neither survived
// the request.
//
// THE ONE PROPERTY THIS FILE EXISTS TO PRESERVE. A rejected candidate and a
// candidate that was never offered must not look the same in the data. So the
// row keeps BOTH sides: what was put to the model (`visual_candidates`) and
// what came back (`visual_rulings`). Nothing offered, offered-and-ignored, and
// offered-and-refused are three different findings with three different fixes,
// and a table that only stored rulings would collapse them into one.
//
// Everything here is best-effort. A provenance write that fails must never
// fail an extraction — the record of a decision is worth less than the
// decision.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandidateRuling, VisualCandidate } from "./visual-candidates.ts";
import type { CategoryDecision } from "./category-decision.ts";

const TABLE = "identification_provenance";

export interface ExtractionProvenanceInput {
  ownerUserId: string;
  itemId?: string | null;
  /** The ai_enrichment_log row this run wrote, when it wrote one. */
  enrichmentLogId?: string | null;
  candidates: readonly VisualCandidate[];
  rulings: readonly CandidateRuling[];
  /**
   * Why the pass offered nothing, when it offered nothing (US-2779).
   *
   * Null on a run that produced candidates. Without it, "the gate refused to
   * search a ruler shot" and "eBay has nothing that looks like this garment"
   * are the same empty array — the same collapse this file exists to prevent,
   * one level down.
   */
  visualDeclined?: string | null;
}

/**
 * The row an extraction writes. Pure, so the shape can be asserted without a
 * database — the interesting part is that both halves are always present, even
 * when empty.
 */
export function buildExtractionRow(
  input: ExtractionProvenanceInput,
): Record<string, unknown> {
  return {
    owner_user_id: input.ownerUserId,
    inventory_item_id: input.itemId ?? null,
    enrichment_log_id: input.enrichmentLogId ?? null,
    visual_candidates: input.candidates.map((c) => ({
      field: c.field,
      value: c.value,
      support: c.support,
      out_of: c.outOf,
    })),
    visual_rulings: input.rulings.map((r) => ({
      field: r.field,
      value: r.value,
      verdict: r.verdict,
      evidence: r.evidence,
    })),
    visual_declined: input.visualDeclined ?? null,
  };
}

/** The patch the eBay prep phase adds once the category is settled. */
export function buildCategoryPatch(
  decision: CategoryDecision,
  decidedAt: string,
): Record<string, unknown> {
  return {
    category_method: decision.method,
    category_id: decision.categoryId,
    category_name: decision.categoryName,
    category_support: decision.support,
    // Carried even when the method is `visual_consensus` and it is null: the
    // absence of a rejection is as much a reading as a rejection is.
    category_rejected_reason: decision.rejectedReason,
    category_decided_at: decidedAt,
  };
}

/**
 * Record what the extraction offered and what the model ruled. Returns the row
 * id so the eBay phase can complete the same row rather than open a second one.
 */
export async function recordExtractionProvenance(
  supabase: SupabaseClient,
  input: ExtractionProvenanceInput,
): Promise<string | null> {
  if (!input.ownerUserId) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .insert(buildExtractionRow(input))
    .select("id")
    .single();
  if (error) {
    console.error("[provenance] extraction row failed:", error.message);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

export interface CategoryProvenanceInput {
  ownerUserId: string;
  itemId?: string | null;
  /** The row recordExtractionProvenance opened, when this run opened one. */
  provenanceId?: string | null;
  decision: CategoryDecision;
}

/**
 * Record the category decision.
 *
 * Completes the extraction's row when there is one. When there is not — the
 * extraction insert failed, or the phase was reached by some other path — it
 * opens its own row rather than dropping the decision, and that row's empty
 * `visual_candidates` reads correctly as "nothing was offered on this run".
 *
 * The update is scoped by owner_user_id as well as by id (US-268). The id here
 * is ours, not the caller's, so this is belt and braces — but a scoping rule
 * that is applied only when it is load-bearing is a rule nobody can review.
 */
export async function recordCategoryDecision(
  supabase: SupabaseClient,
  input: CategoryProvenanceInput,
): Promise<boolean> {
  if (!input.ownerUserId) return false;
  const patch = buildCategoryPatch(input.decision, new Date().toISOString());

  if (input.provenanceId) {
    const { error } = await supabase
      .from(TABLE)
      .update(patch)
      .eq("id", input.provenanceId)
      .eq("owner_user_id", input.ownerUserId);
    if (!error) return true;
    console.error("[provenance] category update failed:", error.message);
    return false;
  }

  const { error } = await supabase.from(TABLE).insert({
    owner_user_id: input.ownerUserId,
    inventory_item_id: input.itemId ?? null,
    ...patch,
  });
  if (error) {
    console.error("[provenance] category row failed:", error.message);
    return false;
  }
  return true;
}
