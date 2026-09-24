// The local writes that follow an eBay post-sale outcome (a refund, an
// approved cancellation, an accepted dispute).
//
// Moved out of routes/flipdesk-ebay-post-sale.ts (PS-03) so the write plan can
// be exercised against a recording fake instead of a live database. The route
// still calls it exactly once per action.
//
// Tenant-scoped by construction (US-268): every write filters on ownerId, and
// the item and listing ids come from the owner-scoped sale rows this function
// has just updated, AND carry their own user_id filter.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase.ts";
import { reverseConsignorPayoutsForSales } from "./consignor-payout.ts";
import { outcomeWritePlan, type SaleOutcome } from "./ebay-postorder.ts";

export interface OutcomeDeps {
  db: Pick<SupabaseClient, "from">;
  reversePayouts: (saleIds: string[], ownerId: string, reason: string) => Promise<unknown>;
}

const DEFAULT_DEPS: OutcomeDeps = {
  db: supabaseAdmin,
  reversePayouts: (saleIds, ownerId, reason) =>
    reverseConsignorPayoutsForSales(saleIds, ownerId, { reason }),
};

// Update the local sale's lifecycle after an eBay outcome (best-effort). Scoped
// to the owner. The order id is resolved by the caller (PS-04).
export async function applyOutcomeToSale(
  ownerId: string,
  orderId: unknown,
  outcome: SaleOutcome,
  deps: OutcomeDeps = DEFAULT_DEPS,
): Promise<void> {
  const plan = outcomeWritePlan(outcome);
  if (!plan.saleStatus || typeof orderId !== "string" || !orderId) return;
  const { db } = deps;
  const { data: updatedSales, error } = await db
    .from("sales")
    .update({ status: plan.saleStatus, cancelled_at: new Date().toISOString() })
    .eq("user_id", ownerId)
    .eq("platform_order_id", orderId)
    .select("id, inventory_item_id, listing_id");
  if (error) {
    console.error("[ebay.postorder] local sale update failed:", error.message);
    return;
  }

  // US-1451: a refunded return / approved cancellation means the item came back —
  // only flipping the sale to refunded/cancelled strands the item as sold/shipped
  // (outside the relist loop) and still counts it in Sold aggregates. Restore the
  // item to 'returned' (the relist-loop entry) and end its listing so it's no
  // longer shown live. PS-03: an item-not-received refund or an accepted
  // dispute does NOT restore, because nothing came back.
  const rows = (updatedSales ?? []) as Array<{
    id: string;
    inventory_item_id: string | null;
    listing_id: string | null;
  }>;

  // US-2022: the consignor was paid for a sale that no longer exists. Reverse
  // (or cancel) their payout. Best-effort and idempotent.
  if (plan.reversePayout && rows.length > 0) {
    await deps.reversePayouts(rows.map((r) => r.id), ownerId, `ebay ${outcome}`)
      .catch((err) => {
        console.error("[ebay.postorder] consignor payout reversal failed:", err);
      });
  }
  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id).filter(Boolean))] as string[];
  const listingIds = [...new Set(rows.map((r) => r.listing_id).filter(Boolean))] as string[];

  if (plan.restoreItem && itemIds.length > 0) {
    const { error: iErr } = await db
      .from("inventory_items")
      .update({ status: "returned" })
      .eq("user_id", ownerId)
      .in("id", itemIds);
    if (iErr) {
      console.error("[ebay.postorder] item restore failed:", iErr.message);
    }
  }
  if (plan.endListing && listingIds.length > 0) {
    const { error: lErr } = await db
      .from("listings")
      .update({ listing_status: "ended", is_active: false })
      .eq("user_id", ownerId)
      .in("id", listingIds);
    if (lErr) {
      console.error("[ebay.postorder] listing restore failed:", lErr.message);
    }
  }
}
