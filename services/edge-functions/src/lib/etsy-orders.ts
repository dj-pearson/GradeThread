// Shared Etsy receipt → FlipDesk ingest (US-1660). One place owns "an Etsy order
// landed" so the manual sync (the adapter's syncOrders / a reconciliation pull)
// and any future webhook can't drift apart. Mirrors depop-orders.ts in structure:
//
//   paid receipt      → sales row (dedupe by listing_id) + inventory_items.status
//                       ='sold' + auto-end the garment's other-platform siblings
//                       (US-564). Idempotent on the sale's listing_id + an
//                       etsy:<receipt>:<listing> payout ref, so a re-sync is a
//                       no-op. The Etsy receipt/listing ids are stashed on
//                       sales.platform_order_ref (reuses the depop 00176 column).
//   cancelled/refunded → flip the matching sale row's status.
//
// MATCHING: Etsy transactions carry the listing_id, which we persist as
// listings.platform_listing_id at publish (US-1660). We match on that first, and
// fall back to the transaction SKU → inventory_items.sku for listings published
// before the id round-trips.
//
// SECURITY (US-268): every write is tenant-scoped. We only touch listings/sales
// reached THROUGH a listings row whose inventory_items.user_id equals the
// resolved owner — never by an id taken from the receipt payload.

import { supabaseAdmin } from "./supabase.ts";
import {
  type EtsyReceipt,
  etsyRefundStatus,
  estimateEtsyNet,
} from "./etsy-api.ts";
import { autoEndCrossListings } from "./cross-listings.ts";

export interface EtsyOrderIngestResult {
  salesNew: number;
  payoutsNew: number;
  soldFlipped: number;
  statusUpdated: number;
  errors: string[];
}

function emptyResult(): EtsyOrderIngestResult {
  return { salesNew: 0, payoutsNew: 0, soldFlipped: 0, statusUpdated: 0, errors: [] };
}

interface MatchedListing {
  id: string;
  inventory_item_id: string;
  listing_status: string;
  platform_listing_id: string | null;
  sku: string | null;
}

// Maps the receipt's transactions → the owner's local Etsy listings. Tenant-
// scoped via inventory_items.user_id (listings carry no user_id). Matches on
// platform_listing_id (the Etsy listing id we published under) OR the item SKU.
// Returns a map keyed by BOTH the etsy listing id and the sku (whichever the
// caller has), so a transaction resolves by either. Empty when nothing matches.
async function listingsForReceipt(
  userId: string,
  receipt: EtsyReceipt,
): Promise<Map<string, MatchedListing>> {
  const listingIds = new Set<string>();
  const skus = new Set<string>();
  for (const tx of receipt.transactions) {
    if (tx.listingId) listingIds.add(tx.listingId);
    if (tx.sku) skus.add(tx.sku);
  }
  const byKey = new Map<string, MatchedListing>();
  if (listingIds.size === 0 && skus.size === 0) return byKey;

  // Pull the owner's etsy listings whose platform_listing_id OR item sku is in
  // this receipt. Two scoped selects (never .or on a mutation — SELECT .or is
  // fine, but two narrow selects keep the index usage simple and are unioned in
  // JS). Tenant-scoped through inventory_items.user_id.
  const add = (rows: unknown[]) => {
    for (
      const r of (rows ?? []) as unknown as Array<{
        id: string;
        inventory_item_id: string;
        listing_status: string;
        platform_listing_id: string | null;
        inventory_items: { sku: string | null };
      }>
    ) {
      const m: MatchedListing = {
        id: r.id,
        inventory_item_id: r.inventory_item_id,
        listing_status: r.listing_status,
        platform_listing_id: r.platform_listing_id,
        sku: r.inventory_items?.sku ?? null,
      };
      if (m.platform_listing_id) byKey.set(m.platform_listing_id, m);
      if (m.sku) byKey.set(m.sku, m);
    }
  };

  const SELECT =
    "id, inventory_item_id, listing_status, platform_listing_id, inventory_items!inner(user_id, sku)";
  if (listingIds.size > 0) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select(SELECT)
      .eq("platform", "etsy")
      .eq("inventory_items.user_id", userId)
      .in("platform_listing_id", [...listingIds]);
    add(data ?? []);
  }
  if (skus.size > 0) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select(SELECT)
      .eq("platform", "etsy")
      .eq("inventory_items.user_id", userId)
      .in("inventory_items.sku", [...skus]);
    add(data ?? []);
  }
  return byKey;
}

function matchTransaction(
  byKey: Map<string, MatchedListing>,
  tx: { listingId: string | null; sku: string | null },
): MatchedListing | null {
  if (tx.listingId && byKey.has(tx.listingId)) return byKey.get(tx.listingId)!;
  if (tx.sku && byKey.has(tx.sku)) return byKey.get(tx.sku)!;
  return null;
}

// Ingests a PAID receipt: per matching transaction, mark the listing sold
// (idempotent), flip the item to 'sold', auto-end cross-listed siblings, and
// ensure a sale + payout_imports row exists. Never throws — failures collect
// into result.errors.
export async function ingestEtsyReceipt(
  userId: string,
  receipt: EtsyReceipt,
): Promise<EtsyOrderIngestResult> {
  const result = emptyResult();
  const byKey = await listingsForReceipt(userId, receipt);
  if (byKey.size === 0) return result;

  const soldAt = receipt.soldAt ?? new Date().toISOString();
  const seen = new Set<string>();

  for (const tx of receipt.transactions) {
    const listing = matchTransaction(byKey, tx);
    if (!listing) continue;
    // A receipt can list the same listing twice; process each listing once.
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);

    const ref = `etsy:${receipt.receiptId}:${listing.platform_listing_id ?? listing.sku ?? listing.id}`;
    const gross = tx.price > 0 ? tx.price * (tx.quantity > 0 ? tx.quantity : 1) : receipt.total;
    const net = estimateEtsyNet(gross);

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

    // Ensure a sale row exists for this listing (dedupe by listing_id).
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
        buyer_username: receipt.buyerName || null,
        status: "completed",
        platform_order_ref: {
          platform: "etsy",
          receipt_id: receipt.receiptId,
          listing_id: listing.platform_listing_id,
          sku: listing.sku,
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
        marketplace: "etsy",
        import_method: "api_sync",
        amount: net,
        payout_date: soldAt.slice(0, 10),
        reconciled: false,
        raw_payload: {
          external_id: ref,
          payoutid: ref,
          receipt_id: receipt.receiptId,
          listing_id: listing.platform_listing_id,
          sku: listing.sku,
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

// Applies a cancel/refund to the sale rows behind this receipt. Tenant-scoped: we
// only update sales whose listing_id belongs to a listing already verified to be
// the owner's. Idempotent — skips rows already in the target status.
export async function applyEtsyReceiptStatus(
  userId: string,
  receipt: EtsyReceipt,
): Promise<EtsyOrderIngestResult> {
  const result = emptyResult();
  const target = etsyRefundStatus(receipt);
  if (!target) return result;

  const byKey = await listingsForReceipt(userId, receipt);
  const listingIds = Array.from(new Set([...byKey.values()].map((l) => l.id)));
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

// Single entry point for a receipt: a cancelled/refunded receipt updates sale
// status; an otherwise paid receipt is ingested; anything else waits.
export async function handleEtsyReceiptEvent(
  userId: string,
  receipt: EtsyReceipt,
): Promise<EtsyOrderIngestResult & { kind: "ingest" | "status" | "skip" }> {
  if (etsyRefundStatus(receipt)) {
    return { kind: "status", ...(await applyEtsyReceiptStatus(userId, receipt)) };
  }
  const s = (receipt.status ?? "").toLowerCase();
  // Etsy receipts are purchases; treat missing/paid/completed as a sale, an
  // explicit open/processing state waits until it settles.
  if (!s || /paid|complete|fulfil|ship/.test(s)) {
    return { kind: "ingest", ...(await ingestEtsyReceipt(userId, receipt)) };
  }
  return { kind: "skip", ...emptyResult() };
}
