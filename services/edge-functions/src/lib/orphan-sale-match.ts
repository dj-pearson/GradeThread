// Manually link an orphaned eBay sale to an inventory item (US-898).
//
// flipdesk_ebay_orphan_sales holds eBay order line items the pull couldn't match
// to a FlipDesk inventory_item by SKU or eBay item id (snapshotOrphanSale in
// flipdesk-ebay.ts). An operator (admin sync console) or — later — the seller can
// resolve one by pointing it at the right inventory item: this creates the
// missing sales row and marks the orphan matched.
//
// TENANT ISOLATION (US-268, AC5): both the orphan row AND the target inventory
// item are loaded scoped to the SAME `ownerId`. The caller resolves `ownerId`
// from the orphan's `user_id` before calling in, so a match can NEVER attach a
// sale to another tenant's item — if the item isn't owned by the orphan's owner
// the lookup returns null and the match is refused.

import { supabaseAdmin } from "./supabase.ts";

// Structural subset of the supabase client this module uses. The real
// service-role client satisfies it; the tenant-isolation test injects a fake.
export type OrphanMatchClient = Pick<typeof supabaseAdmin, "from">;

interface OrphanRow {
  id: string;
  user_id: string;
  platform_order_id: string;
  line_item_id: string;
  ebay_item_id: string | null;
  sku: string | null;
  title: string | null;
  sale_price: number | null;
  shipping_collected: number | null;
  tax: number | null;
  buyer_username: string | null;
  sold_at: string | null;
  match_status: string;
}

export type MatchOrphanResult =
  | { ok: true; sale_id: string | null; created: boolean }
  | {
    ok: false;
    code: "orphan_not_found" | "item_not_found" | "already_matched" | "db_error";
    error: string;
  };

const ORPHAN_SELECT =
  "id, user_id, platform_order_id, line_item_id, ebay_item_id, sku, title, " +
  "sale_price, shipping_collected, tax, buyer_username, sold_at, match_status";

// Link orphan `orphanId` (owned by `ownerId`) to inventory item `inventoryItemId`
// (which MUST also be owned by `ownerId`). Creates a completed sales row from the
// orphan snapshot (idempotent on the order/line-item dedupe), flips the item to
// 'sold', and marks the orphan matched. `client` defaults to the service-role
// client; tests inject a fake.
export async function matchOrphanSale(
  ownerId: string,
  orphanId: string,
  inventoryItemId: string,
  client: OrphanMatchClient = supabaseAdmin,
): Promise<MatchOrphanResult> {
  // 1. Load + ownership-check the orphan (scoped to ownerId).
  const { data: orphanRaw, error: orphanErr } = await client
    .from("flipdesk_ebay_orphan_sales")
    .select(ORPHAN_SELECT)
    .eq("id", orphanId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (orphanErr) {
    return { ok: false, code: "db_error", error: orphanErr.message };
  }
  if (!orphanRaw) {
    return { ok: false, code: "orphan_not_found", error: "Orphan sale not found." };
  }
  const orphan = orphanRaw as unknown as OrphanRow;
  if (orphan.match_status === "matched") {
    return { ok: false, code: "already_matched", error: "Orphan sale is already matched." };
  }

  // 2. Load + ownership-check the target item (scoped to the SAME ownerId). If
  //    the item belongs to a different tenant this yields null → refuse. This is
  //    the cross-tenant wall (AC5).
  const { data: itemRaw, error: itemErr } = await client
    .from("inventory_items")
    .select("id, user_id")
    .eq("id", inventoryItemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (itemErr) {
    return { ok: false, code: "db_error", error: itemErr.message };
  }
  if (!itemRaw) {
    return {
      ok: false,
      code: "item_not_found",
      error: "Inventory item not found for this account.",
    };
  }

  // 3. Dedupe: if a sale already exists for (item, order, line item), don't
  //    double-insert — just adopt it. Mirrors the pull's dedupe key (US-468).
  const { data: existingRaw } = await client
    .from("sales")
    .select("id")
    .eq("inventory_item_id", inventoryItemId)
    .eq("platform_order_id", orphan.platform_order_id)
    .eq("line_item_id", orphan.line_item_id ?? "")
    .maybeSingle();
  let saleId = (existingRaw as { id: string } | null)?.id ?? null;
  let created = false;

  if (!saleId) {
    const salePayload = {
      inventory_item_id: inventoryItemId,
      platform_order_id: orphan.platform_order_id,
      line_item_id: orphan.line_item_id ?? "",
      quantity: 1,
      sale_price: orphan.sale_price ?? 0,
      sale_date: orphan.sold_at ? orphan.sold_at.slice(0, 10) : null,
      sold_at: orphan.sold_at,
      buyer_username: orphan.buyer_username,
      buyer_id: orphan.buyer_username,
      shipping_collected: orphan.shipping_collected ?? 0,
      tax: orphan.tax ?? 0,
      status: "completed" as const,
    };
    const { data: insertedRaw, error: insertErr } = await client
      .from("sales")
      .insert(salePayload)
      .select("id")
      .maybeSingle();
    if (insertErr) {
      return { ok: false, code: "db_error", error: insertErr.message };
    }
    saleId = (insertedRaw as { id: string } | null)?.id ?? null;
    created = true;

    // Flip the item to sold (best-effort; never undo real fulfillment states).
    await client
      .from("inventory_items")
      .update({ status: "sold" })
      .eq("id", inventoryItemId)
      .eq("user_id", ownerId)
      .not("status", "in", "(shipped,completed,returned)");
  }

  // 4. Mark the orphan matched (scoped to ownerId).
  const { error: markErr } = await client
    .from("flipdesk_ebay_orphan_sales")
    .update({ matched_item_id: inventoryItemId, match_status: "matched" })
    .eq("id", orphanId)
    .eq("user_id", ownerId);
  if (markErr) {
    return { ok: false, code: "db_error", error: markErr.message };
  }

  return { ok: true, sale_id: saleId, created };
}
