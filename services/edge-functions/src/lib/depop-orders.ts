// Shared Depop order → FlipDesk ingest (US-714). One place owns "a Depop order
// landed" so the manual sync (the adapter's syncOrders / a reconciliation pull)
// and the live order webhook (flipdesk-webhooks /depop) can't drift apart.
// Mirrors shopify-orders.ts verbatim in structure:
//
//   paid order        → sales row (platform via listing) + inventory_items.status
//                       ='sold' + auto-end the garment's other-platform siblings
//                       (US-564). Idempotent on the sale's listing_id + a
//                       depop:<purchase>:<sku> payout ref, so a re-delivery /
//                       re-sync is a no-op. The Depop purchase_id + parcel_id are
//                       stashed on sales.platform_order_ref so the mark-as-shipped
//                       action can find them later (migration 00176).
//   cancelled/refunded → flip the matching sale row's status.
//
// SECURITY (US-268): every write is tenant-scoped. We only touch listings/sales
// reached THROUGH a listings row whose inventory_items.user_id equals the
// resolved owner — never by an id taken from the order payload. The SKU on the
// order maps to OUR inventory_items.sku (we publish products keyed by that SKU).

import { supabaseAdmin } from "./supabase.ts";
import {
  type DepopOrder,
  depopRefundStatus,
  estimateDepopNet,
} from "./depop-api.ts";
import { autoEndCrossListings } from "./cross-listings.ts";

export interface DepopOrderIngestResult {
  salesNew: number;
  payoutsNew: number;
  soldFlipped: number;
  statusUpdated: number;
  errors: string[];
}

function emptyResult(): DepopOrderIngestResult {
  return { salesNew: 0, payoutsNew: 0, soldFlipped: 0, statusUpdated: 0, errors: [] };
}

interface MatchedListing {
  id: string;
  inventory_item_id: string;
  listing_status: string;
  sku: string;
}

// Maps the order's purchased SKUs → the owner's local Depop listings. Tenant-
// scoped via inventory_items.user_id (listings carry no user_id). Keyed by SKU
// because that's what Depop publishes/echoes (PUT /products/{sku}). Returns an
// empty map when the order touches nothing we track.
async function listingsForOrder(
  userId: string,
  order: DepopOrder,
): Promise<Map<string, MatchedListing>> {
  const skus = new Set<string>();
  for (const li of order.lineItems) {
    if (li.sku) skus.add(li.sku);
  }
  const bySku = new Map<string, MatchedListing>();
  if (skus.size === 0) return bySku;

  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, listing_status, inventory_items!inner(user_id, sku)",
    )
    .eq("platform", "depop")
    .eq("inventory_items.user_id", userId)
    .in("inventory_items.sku", [...skus]);
  for (
    const r of (rows ?? []) as unknown as Array<{
      id: string;
      inventory_item_id: string;
      listing_status: string;
      inventory_items: { sku: string | null };
    }>
  ) {
    const sku = r.inventory_items?.sku;
    if (sku) {
      bySku.set(sku, {
        id: r.id,
        inventory_item_id: r.inventory_item_id,
        listing_status: r.listing_status,
        sku,
      });
    }
  }
  return bySku;
}

// Picks the parcel id to track for fulfillment: the first not-yet-shipped parcel,
// else the first parcel. Returns null when the order carries no parcels yet.
function trackableParcelId(order: DepopOrder): string | null {
  const pending = order.parcels.find((p) => p.parcelId && !p.shipped);
  if (pending?.parcelId) return pending.parcelId;
  return order.parcels.find((p) => p.parcelId)?.parcelId ?? null;
}

// Ingests a PAID order: per matching line item, mark the listing sold
// (idempotent), flip the item to 'sold', auto-end cross-listed siblings, and
// ensure a sale + payout_imports row exists. Never throws — failures collect
// into result.errors.
export async function ingestDepopOrder(
  userId: string,
  order: DepopOrder,
): Promise<DepopOrderIngestResult> {
  const result = emptyResult();
  const listingBySku = await listingsForOrder(userId, order);
  if (listingBySku.size === 0) return result;

  const parcelId = trackableParcelId(order);
  const soldAt = order.soldAt ?? new Date().toISOString();

  for (const li of order.lineItems) {
    if (!li.sku) continue;
    const listing = listingBySku.get(li.sku);
    if (!listing) continue;

    const ref = `depop:${order.purchaseId}:${li.sku}`;
    const gross = li.price > 0 ? li.price * (li.quantity > 0 ? li.quantity : 1) : order.total;
    const net = estimateDepopNet(gross);

    // Mark the listing sold (idempotent) + flip the item + end siblings.
    if (listing.listing_status !== "sold") {
      await supabaseAdmin
        .from("listings")
        .update({ listing_status: "sold", is_active: false })
        .eq("id", listing.id);
      await supabaseAdmin
        .from("inventory_items")
        .update({ status: "sold" })
        .eq("id", listing.inventory_item_id);
      await autoEndCrossListings(userId, listing.id);
      result.soldFlipped += 1;
    }

    // Ensure a sale row exists for this listing (dedupe by listing_id). The
    // Depop order/parcel ids ride on platform_order_ref so mark-as-shipped can
    // find them later (US-714 AC2).
    const { data: existingSale } = await supabaseAdmin
      .from("sales")
      .select("id")
      .eq("listing_id", listing.id)
      .limit(1)
      .maybeSingle();
    if (!existingSale) {
      const { error: saleErr } = await supabaseAdmin.from("sales").insert({
        inventory_item_id: listing.inventory_item_id,
        listing_id: listing.id,
        sale_price: gross,
        payout_amount: net,
        payment_processing_fees: Math.max(0, Math.round((gross - net) * 100) / 100),
        sold_at: soldAt,
        sale_date: soldAt.slice(0, 10),
        buyer_username: order.buyerUsername || null,
        status: "completed",
        platform_order_ref: {
          platform: "depop",
          purchase_id: order.purchaseId,
          order_id: order.orderId,
          parcel_id: parcelId,
          sku: li.sku,
        },
      });
      if (saleErr) {
        result.errors.push(`sale insert: ${saleErr.message}`);
      } else {
        result.salesNew += 1;
      }
    }

    // Ensure a payout_imports row exists (dedupe by raw_payload->>external_id).
    const { data: existingPayout } = await supabaseAdmin
      .from("payout_imports")
      .select("id")
      .eq("user_id", userId)
      .eq("raw_payload->>external_id", ref)
      .limit(1)
      .maybeSingle();
    if (!existingPayout) {
      const { error: payoutErr } = await supabaseAdmin.from("payout_imports").insert({
        user_id: userId,
        marketplace: "depop",
        import_method: "api_sync",
        amount: net,
        payout_date: soldAt.slice(0, 10),
        reconciled: false,
        raw_payload: {
          external_id: ref,
          payoutid: ref,
          purchase_id: order.purchaseId,
          order_id: order.orderId,
          sku: li.sku,
          gross,
          net,
        },
      });
      if (payoutErr) {
        result.errors.push(`payout insert: ${payoutErr.message}`);
      } else {
        result.payoutsNew += 1;
      }
    }
  }
  return result;
}

// Applies a cancel/refund to the sale rows behind this order. Tenant-scoped: we
// only update sales whose listing_id belongs to a listing already verified to be
// the owner's. Idempotent — skips rows already in the target status.
export async function applyDepopOrderStatus(
  userId: string,
  order: DepopOrder,
): Promise<DepopOrderIngestResult> {
  const result = emptyResult();
  const target = depopRefundStatus(order);
  if (!target) return result;

  const listingBySku = await listingsForOrder(userId, order);
  const listingIds = [...listingBySku.values()].map((l) => l.id);
  if (listingIds.length === 0) return result;

  const { data: updated, error } = await supabaseAdmin
    .from("sales")
    .update({ status: target, cancelled_at: new Date().toISOString() })
    .in("listing_id", listingIds)
    .neq("status", target)
    .select("id");
  if (error) {
    result.errors.push(`status update: ${error.message}`);
  } else {
    result.statusUpdated = (updated ?? []).length;
  }
  return result;
}

// Single entry point for an inbound order event: a cancelled/refunded order
// updates sale status; an otherwise paid/completed order is ingested; anything
// else (pending) is skipped until it settles.
export async function handleDepopOrderEvent(
  userId: string,
  order: DepopOrder,
): Promise<DepopOrderIngestResult & { kind: "ingest" | "status" | "skip" }> {
  if (depopRefundStatus(order)) {
    return { kind: "status", ...(await applyDepopOrderStatus(userId, order)) };
  }
  const s = (order.status ?? "").toLowerCase();
  // Treat a missing status as a sale (the orders feed only returns purchases);
  // an explicit pending/unpaid state waits.
  if (!s || /paid|complete|sold|fulfil|dispatch|ship/.test(s)) {
    return { kind: "ingest", ...(await ingestDepopOrder(userId, order)) };
  }
  return { kind: "skip", ...emptyResult() };
}
