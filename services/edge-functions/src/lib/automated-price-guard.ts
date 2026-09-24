// One eligibility rule for every AUTOMATED price change.
//
// FlipDesk has two engines that move a live price on a schedule: the repricing
// rules (routes/flipdesk-pricing.ts, logged to repricing_actions) and the
// Automations rules (routes/flipdesk-automations.ts, logged to
// flipdesk_automation_actions). Each used to read only its own log for its
// cooldown, so a "10% every 7 days" rule in each tab cut the same garment about
// 19% a week and neither engine could see the other doing it.
//
// This module is the shared anchor: the newest automated price change on each
// listing from EITHER engine. A runner skips a listing whose anchor is newer
// than its own rule's interval. Manual changes (the seller's Apply, bulk apply,
// Undo) are logged to repricing_actions with rule_id null and are NOT counted:
// a hand-set price is protected by price_set_by instead.
//
// Tenant-scoped: every read filters on the owner (US-268).

import { supabaseAdmin } from "./supabase.ts";
import { selectMarkdownItems } from "./markdown-rules.ts";
import { loadMarkdownCandidates } from "./markdown-candidates.ts";

/** Automation action types that change what a buyer pays. */
export const AUTOMATION_PRICE_ACTION_TYPES: readonly string[] = [
  "price_drop_pct",
  "create_coded_coupon",
];

/**
 * listing id -> ISO time of the newest automated price change from either
 * engine. Listings with none are absent.
 */
export async function lastAutomatedPriceChangeByListing(
  ownerId: string,
  listingIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (listingIds.length === 0) return out;
  const keep = (listingId: string | null, at: string) => {
    if (!listingId) return;
    const prev = out.get(listingId);
    if (!prev || Date.parse(at) > Date.parse(prev)) out.set(listingId, at);
  };

  const [reprice, automation] = await Promise.all([
    supabaseAdmin
      .from("repricing_actions")
      .select("listing_id, created_at")
      .eq("user_id", ownerId)
      .in("listing_id", listingIds)
      .not("rule_id", "is", null),
    supabaseAdmin
      .from("flipdesk_automation_actions")
      .select("listing_id, created_at")
      .eq("user_id", ownerId)
      .in("listing_id", listingIds)
      .in("action_type", [...AUTOMATION_PRICE_ACTION_TYPES]),
  ]);
  if (reprice.error) {
    console.error("[price-guard] repricing_actions read failed:", reprice.error.message);
  }
  if (automation.error) {
    console.error("[price-guard] automation actions read failed:", automation.error.message);
  }
  for (const r of (reprice.data ?? []) as Array<{ listing_id: string | null; created_at: string }>) {
    keep(r.listing_id, r.created_at);
  }
  for (
    const r of (automation.data ?? []) as Array<{ listing_id: string | null; created_at: string }>
  ) {
    keep(r.listing_id, r.created_at);
  }
  return out;
}

/** True when the last automated change is at least `days` old, or there is none. */
export function automatedCooldownPassed(
  lastIso: string | null | undefined,
  days: number,
  now: Date,
): boolean {
  if (!lastIso) return true;
  const t = Date.parse(lastIso);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= days * 86_400_000;
}

/**
 * Listings the Automations markdown sale covers right now: the set its active
 * markdown_schedule rules would select. The sale lives on eBay under a name,
 * not on the listing row, so this recomputes the same selection the runner
 * sends. Used by the repricing runner so it never cuts a base price under a
 * live sale from the other engine.
 */
export async function listingsInAutomationMarkdown(ownerId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .select("trigger_json")
    .eq("user_id", ownerId)
    .eq("is_active", true);
  if (error) {
    console.error("[price-guard] markdown rule read failed:", error.message);
    return out;
  }
  const triggers = ((data ?? []) as Array<{ trigger_json: Record<string, unknown> | null }>)
    .map((r) => r.trigger_json)
    .filter((t): t is Record<string, unknown> => t?.type === "markdown_schedule");
  if (triggers.length === 0) return out;
  const candidates = await loadMarkdownCandidates(ownerId);
  for (const t of triggers) {
    const selection = selectMarkdownItems({
      minDaysListed: Number(t.min_days_listed) || 1,
      markdownPct: Number(t.markdown_pct) || 0,
      marginFloorPct: Number(t.margin_floor_pct) || 0,
      minGrade: t.min_grade == null ? null : Number(t.min_grade),
    }, candidates);
    for (const i of selection.included) out.add(i.listingId);
  }
  return out;
}
