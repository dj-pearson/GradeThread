// US-2944: the active offer rule for one seller, read once.
//
// The publish/revise path needs to know whether an offer rule is running before
// it pushes an auto-accept price to eBay, and the offers page needs the same
// answer to report a conflict. Its own module so both callers get the same
// reading of "active" — a second copy would be a second definition of which
// rule wins when a seller has two.
//
// Tenant-scoped: takes an ownerId and filters on it (US-268).

import { supabaseAdmin } from "./supabase.ts";

export interface ActiveOfferRule {
  id: string;
  acceptAtPct: number | null;
  marginFloorPct: number;
}

/**
 * The seller's active offer-threshold rule, or null.
 *
 * WHICH RULE, when there are several: the OLDEST enabled one that sets an
 * accept threshold. Not the newest — the offer runner iterates rules in the
 * order it loaded them and takes the first that fires, so picking the newest
 * here would report a conflict against a rule that the runner never reaches.
 * The two have to agree about which rule is in charge or the banner is noise.
 */
export async function loadActiveOfferRule(
  ownerId: string,
): Promise<ActiveOfferRule | null> {
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    // The column is is_active (00135), NOT enabled. Named wrongly this
    // whole function 42703s and returns null, which reads as "no rule" — so
    // the reconcile silently does nothing rather than failing loudly.
    .select("id, trigger_json, is_active, created_at")
    .eq("user_id", ownerId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) {
    console.error("[offer-rule-lookup] load failed:", error.message);
    return null;
  }
  for (
    const row of (data ?? []) as unknown as Array<{
      id: string;
      trigger_json: { type?: string; accept_at_pct?: number | null; margin_floor_pct?: number };
    }>
  ) {
    const t = row.trigger_json;
    if (t?.type !== "offer_threshold") continue;
    if (t.accept_at_pct == null) continue;
    return {
      id: row.id,
      acceptAtPct: t.accept_at_pct,
      // Defaulted rather than required: a rule stored before the floor existed
      // still gets the safety net, which is what automation-rules.ts does too.
      marginFloorPct: typeof t.margin_floor_pct === "number" ? t.margin_floor_pct : 10,
    };
  }
  return null;
}
