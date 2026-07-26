// US-2179: the item-level "is this live somewhere?" lifecycle behind the
// activeListings plan cap.
//
// The cap (plan-gate readCurrentUsage → `inventory_items.status = 'listed'`, and
// the billing-summary usage meter, which counts the same way) was only ever fed
// by the eBay publish paths — they are the only writers that flip an item to
// 'listed'. Every other channel created a LIVE listing while leaving the item in
// 'drafted':
//
//   • /flipdesk/listings/cross-push        → depop, etsy, shopify, whatnot
//   • /flipdesk/listings/extension-writeback → poshmark, mercari, grailed
//
// So those listings were neither counted against the cap nor gated by it, and a
// cross-lister's usage meter read 0. The `sold` side of the same lifecycle was
// already handled for non-eBay channels (depop-orders / etsy-orders /
// shopify-orders all set status 'sold'), which is what makes the missing
// `listed` transition an oversight rather than a design choice.
//
// The counting basis stays `inventory_items.status`. Counting `listings` rows
// instead would silently re-scale every existing cap, because one cross-listed
// item owns one row PER platform — an item live on eBay + Depop + Poshmark would
// start consuming 3 of 25 Free slots. "One live item = one slot" is what the
// caps were sized for, so the fix is to make the item status truthful for every
// marketplace rather than to change what gets counted.
//
// TENANT ISOLATION (US-268): every write here is scoped by user_id. Callers pass
// the WORKSPACE OWNER's id — that's whose plan and cap apply.

import { supabaseAdmin } from "./supabase.ts";

// Statuses a publish may advance to 'listed' — the pipeline stages up to and
// including 'drafted'. Deliberately excludes:
//   • the post-sale states (sold/shipped/completed/returned) and 'archived', so a
//     re-push or a late webhook can't drag a sold item back to live;
//   • the personal-use states (keeping/wearing) — an item the seller pulled out
//     of inventory shouldn't silently re-enter it as a live listing.
// Mirrors the guarded advance in flipdesk-autolister.ts.
const PRE_PUBLISH_STATUSES = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "grading",
  "graded",
  "comped",
  "drafted",
] as const;

/**
 * Mark an item live after a successful publish on ANY marketplace, so it counts
 * against the activeListings cap exactly like an eBay publish does.
 *
 * Best-effort: a failure here must never fail a publish that already succeeded
 * upstream (the listing IS live on the marketplace). It logs and returns — the
 * next publish or a reconcile pass re-converges the status. Under-counting the
 * cap for one item is strictly better than telling a seller their listing
 * failed when the marketplace accepted it.
 */
export async function markItemListed(
  inventoryItemId: string | null,
  ownerId: string,
): Promise<void> {
  if (!inventoryItemId) return;
  const { error } = await supabaseAdmin
    .from("inventory_items")
    .update({ status: "listed" })
    .eq("id", inventoryItemId)
    .eq("user_id", ownerId)
    .in("status", [...PRE_PUBLISH_STATUSES]);
  if (error) {
    console.error(
      "[active-listings] markItemListed failed:",
      error.message,
    );
  }
}

/**
 * Does this item still have at least one live listing on any marketplace?
 *
 * Fails CLOSED (returns true) on a read error: the caller uses this to decide
 * whether to RELEASE a cap slot, and wrongly releasing one hands out free
 * over-cap capacity. Keeping the item 'listed' on a transient blip is the safe
 * direction — the next delist re-runs the check.
 */
export async function itemHasActiveListing(
  inventoryItemId: string,
  ownerId: string,
): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("inventory_item_id", inventoryItemId)
    .eq("user_id", ownerId)
    .eq("is_active", true);
  if (error) {
    console.error(
      "[active-listings] itemHasActiveListing query failed:",
      error.message,
    );
    return true; // fail closed — don't free a cap slot on a read error
  }
  return (count ?? 0) > 0;
}

/**
 * Reconcile an item's status after ONE of its listings was ended.
 *
 * Before this existed, every end/delist path reverted the item to 'drafted'
 * unconditionally — so ending the Depop listing of an item that was still live
 * on eBay marked the whole item a draft, dropped it out of the cap count, and
 * showed it in the Drafts tab while it was still selling. Now the item only
 * returns to 'drafted' once nothing is live anywhere.
 *
 * Guarded to 'listed' so a concurrent sale (status 'sold') isn't regressed.
 *
 * Returns null when the item needed no change or was reconciled, and the write
 * error otherwise. Most callers treat this as best-effort and ignore it; the
 * automation engine feeds it to endListingWritesApplied (US-1454) so a failed
 * local write isn't recorded as a successfully applied action.
 */
export async function resyncItemListedStatus(
  inventoryItemId: string | null,
  ownerId: string,
): Promise<{ message: string } | null> {
  if (!inventoryItemId) return null;
  if (await itemHasActiveListing(inventoryItemId, ownerId)) return null;

  const { error } = await supabaseAdmin
    .from("inventory_items")
    .update({ status: "drafted" })
    .eq("id", inventoryItemId)
    .eq("user_id", ownerId)
    .eq("status", "listed");
  if (error) {
    console.error(
      "[active-listings] resyncItemListedStatus failed:",
      error.message,
    );
    return { message: error.message };
  }
  return null;
}

export const __testing = { PRE_PUBLISH_STATUSES };
