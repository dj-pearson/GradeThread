// Garment Passport carry-forward on relist (US-1095).
//
// When a reseller lists an item whose grade is tied to a Garment Passport
// (garment_id on the grade_report), the relist should CONTINUE that chain — we
// append a deterministic 'listed' event to the SAME garment rather than starting
// a new history. This is the bridge that makes resale-through-the-ecosystem
// extend the chain across platforms.
//
// Tenant-scoping (US-268): we only ever resolve a garment through an inventory
// item we've confirmed belongs to the workspace owner — never an id from the
// request. No new garment is created here, so relisting can't duplicate the
// chain.

import { supabaseAdmin } from "./supabase.ts";

/**
 * Resolve the passport garment + slug for an inventory item the caller owns.
 * Returns null when the item isn't the owner's, isn't graded, or its grade has
 * no garment (e.g. a pre-passport grade). Never throws.
 */
export async function resolveGarmentForItem(
  inventoryItemId: string,
  ownerId: string,
): Promise<{ garmentId: string; slug: string | null } | null> {
  try {
    // US-268: confirm ownership AND read the cached grade_report_id in one go.
    const { data: item } = await supabaseAdmin
      .from("inventory_items")
      .select("grade_report_id")
      .eq("id", inventoryItemId)
      .eq("user_id", ownerId)
      .maybeSingle();
    const gradeReportId = (item as { grade_report_id: string | null } | null)?.grade_report_id;
    if (!gradeReportId) return null;

    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("garment_id")
      .eq("id", gradeReportId)
      .maybeSingle();
    const garmentId = (report as { garment_id: string | null } | null)?.garment_id;
    if (!garmentId) return null;

    const { data: garment } = await supabaseAdmin
      .from("garments")
      .select("public_passport_slug")
      .eq("id", garmentId)
      .maybeSingle();
    return {
      garmentId,
      slug: (garment as { public_passport_slug: string } | null)?.public_passport_slug ?? null,
    };
  } catch (e) {
    console.error("[passport-relist] resolveGarmentForItem failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Append a deterministic 'listed' event to a garment's passport (the actor is
 * the garment's current owner — the relisting reseller). Best-effort: a passport
 * failure must never block or fail a listing operation. PII-free payload.
 */
export async function appendListedEvent(
  garmentId: string,
  platform: string,
): Promise<void> {
  try {
    const { data: garment } = await supabaseAdmin
      .from("garments")
      .select("current_owner_node_id")
      .eq("id", garmentId)
      .maybeSingle();
    const actorNodeId = (garment as { current_owner_node_id: string | null } | null)?.current_owner_node_id ?? null;

    await supabaseAdmin.from("garment_events").insert({
      garment_id: garmentId,
      event_type: "listed",
      actor_node_id: actorNodeId,
      payload: { platform: platform.slice(0, 40) },
      confidence: "deterministic",
      source: `relist:${platform}`.slice(0, 200),
    });
  } catch (e) {
    console.error("[passport-relist] appendListedEvent failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Convenience: resolve the owner's item → garment and append a 'listed' event in
 * one call. No-op when the item has no passport. Returns the garment id when an
 * event was appended (else null). Best-effort.
 */
export async function recordRelist(
  inventoryItemId: string,
  ownerId: string,
  platform: string,
): Promise<string | null> {
  const resolved = await resolveGarmentForItem(inventoryItemId, ownerId);
  if (!resolved) return null;
  await appendListedEvent(resolved.garmentId, platform);
  return resolved.garmentId;
}
