// Shared Shopify order → FlipDesk ingest (US-711). One place owns "a Shopify
// order landed" so the manual reconciliation pull (flipdesk-shopify.ts
// /listings/pull) and the live orders webhook (flipdesk-webhooks.ts /shopify)
// can't drift apart. Mirrors the eBay orders-sync semantics:
//
//   paid order      → sales row (platform='shopify') + inventory_items.status
//                     ='sold' + auto-end the garment's other-platform siblings
//                     (US-564). Idempotent on the shop order id (sale dedupe by
//                     listing_id, payout dedupe by the shopify:<order>:<product>
//                     ref) so a re-delivery / re-sync is a no-op.
//   cancelled/refunded → flip the matching sale row's status (AC5).
//
// SECURITY (US-268): every write here is tenant-scoped. We only ever touch
// listings/sales reached THROUGH a listings row whose inventory_items.user_id
// equals the resolved owner — never by an id taken from the order payload.

import { supabaseAdmin } from "./supabase.ts";
import { reverseConsignorPayoutsForSales } from "./consignor-payout.ts";
import {
  estimateShopifyNet,
  listPaidOrders,
  type ShopifyOrder,
} from "./shopify-client.ts";
import { autoEndCrossListings } from "./cross-listings.ts";

export interface ShopifyOrderIngestResult {
  /** New sale rows created. */
  salesNew: number;
  /** New payout_imports rows created (reconciliation feed). */
  payoutsNew: number;
  /** Listings flipped to 'sold' this call. */
  soldFlipped: number;
  /** Sale rows whose status changed (cancel/refund). */
  statusUpdated: number;
  errors: string[];
}

function emptyResult(): ShopifyOrderIngestResult {
  return {
    salesNew: 0,
    payoutsNew: 0,
    soldFlipped: 0,
    statusUpdated: 0,
    errors: [],
  };
}

export interface PaidOrderSyncResult {
  /**
   * false ONLY on a FATAL fetch/ingest error (listPaidOrders threw, or an
   * ingest call threw). The caller MUST NOT advance the sync watermark when
   * this is false. Per-order failures are surfaced in `errors` but do not,
   * by themselves, flip `ok` — those individual orders re-appear in the next
   * window (the watermark hasn't moved past them yet).
   */
  ok: boolean;
  salesNew: number;
  payoutsNew: number;
  errors: string[];
}

// US-1427: fetch + ingest the paid-order reconciliation window since `sinceIso`.
// Extracted from the /listings/pull handler so the watermark-advance decision is
// unit-testable and can't regress: `ok` is the gate the caller uses to decide
// whether to stamp last_synced_at. If listPaidOrders throws (a transient Shopify
// outage), advancing the watermark to now() would permanently skip every paid
// order in this window on the next pull — so on a throw we return ok:false and
// the caller leaves the prior watermark in place. Deps are injectable for tests.
export async function ingestPaidOrdersSince(
  userId: string,
  shop: string,
  token: string,
  sinceIso: string | null,
  deps: {
    listPaidOrders: typeof listPaidOrders;
    ingestShopifyOrder: (
      userId: string,
      order: ShopifyOrder,
    ) => Promise<ShopifyOrderIngestResult>;
  } = { listPaidOrders, ingestShopifyOrder },
): Promise<PaidOrderSyncResult> {
  const errors: string[] = [];
  let salesNew = 0;
  let payoutsNew = 0;
  try {
    const orders = await deps.listPaidOrders(shop, token, sinceIso);
    for (const order of orders) {
      const r = await deps.ingestShopifyOrder(userId, order);
      salesNew += r.salesNew;
      payoutsNew += r.payoutsNew;
      errors.push(...r.errors);
    }
    return { ok: true, salesNew, payoutsNew, errors };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { ok: false, salesNew, payoutsNew, errors };
  }
}

interface MatchedListing {
  id: string;
  inventory_item_id: string;
  listing_status: string;
}

// Maps the order's referenced Shopify product ids → the owner's local listings.
// Tenant-scoped via inventory_items.user_id (listings carry no user_id). Returns
// an empty map when the order touches no products we track.
async function listingsForOrder(
  userId: string,
  order: ShopifyOrder,
): Promise<Map<string, MatchedListing>> {
  const productIds = new Set<string>();
  for (const li of order.lineItems) {
    if (li.productId) productIds.add(li.productId);
  }
  const byProduct = new Map<string, MatchedListing>();
  if (productIds.size === 0) return byProduct;

  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform_listing_id, listing_status, inventory_items!inner(user_id)",
    )
    .eq("platform", "shopify")
    .eq("inventory_items.user_id", userId)
    .in("platform_listing_id", [...productIds]);
  for (
    const r of (rows ?? []) as unknown as Array<{
      id: string;
      inventory_item_id: string;
      platform_listing_id: string;
      listing_status: string;
    }>
  ) {
    byProduct.set(r.platform_listing_id, {
      id: r.id,
      inventory_item_id: r.inventory_item_id,
      listing_status: r.listing_status,
    });
  }
  return byProduct;
}

// Ingests a PAID order: per matching line item, mark the listing sold (idempotent),
// flip the item to 'sold', auto-end cross-listed siblings, and ensure a sale +
// payout_imports row exists. Self-contained + reusable by both the pull and the
// webhook. Never throws — failures are collected into result.errors.
export async function ingestShopifyOrder(
  userId: string,
  order: ShopifyOrder,
): Promise<ShopifyOrderIngestResult> {
  const result = emptyResult();
  const listingByProduct = await listingsForOrder(userId, order);
  if (listingByProduct.size === 0) return result;

  for (const li of order.lineItems) {
    if (!li.productId) continue;
    const listing = listingByProduct.get(li.productId);
    if (!listing) continue;

    const ref = `shopify:${order.id}:${li.productId}`;
    const gross = li.price * (li.quantity > 0 ? li.quantity : 1);
    const net = estimateShopifyNet(gross);
    const soldAt = order.processedAt ?? new Date().toISOString();

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
        buyer_username: order.name || null,
        status: "completed",
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
      const { error: payoutErr } = await supabaseAdmin
        .from("payout_imports")
        .insert({
          user_id: userId,
          marketplace: "shopify",
          import_method: "api_sync",
          amount: net,
          payout_date: soldAt.slice(0, 10),
          reconciled: false,
          raw_payload: {
            external_id: ref,
            payoutid: ref,
            order_id: order.id,
            order_name: order.name,
            product_id: li.productId,
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

// Maps the current order state to a terminal sale status, or null when the order
// is still a live/real sale. cancelled_at wins (an explicitly cancelled order);
// otherwise a fully refunded/voided financial_status. A partial refund is NOT a
// terminal state — the item still sold — so it stays 'completed'.
export function refundStatusForOrder(
  order: ShopifyOrder,
): "cancelled" | "refunded" | null {
  if (order.cancelledAt) return "cancelled";
  const fin = (order.financialStatus ?? "").toLowerCase();
  if (fin === "refunded" || fin === "voided") return "refunded";
  return null;
}

// Applies a cancel/refund to the sale rows behind this order (AC5). Tenant-scoped:
// we only update sales whose listing_id belongs to a listing already verified to
// be the owner's. Idempotent — skips rows already in the target status.
export async function applyShopifyOrderStatus(
  userId: string,
  order: ShopifyOrder,
): Promise<ShopifyOrderIngestResult> {
  const result = emptyResult();
  const target = refundStatusForOrder(order);
  if (!target) return result;

  const listingByProduct = await listingsForOrder(userId, order);
  const listingIds = [...listingByProduct.values()].map((l) => l.id);
  if (listingIds.length === 0) return result;

  const { data: updated, error } = await supabaseAdmin
    .from("sales")
    .update({
      status: target,
      cancelled_at: order.cancelledAt ?? new Date().toISOString(),
    })
    .in("listing_id", listingIds)
    .neq("status", target)
    .select("id");
  if (error) {
    result.errors.push(`status update: ${error.message}`);
  } else {
    result.statusUpdated = (updated ?? []).length;
    // US-2022: a refunded/cancelled order means any consignor payout for these
    // sales is money paid out for a sale that no longer stands. Reverse it —
    // otherwise the payout row reads 'paid' forever and the seller silently
    // eats the consignor's cut. Best-effort and idempotent.
    const reversedSaleIds = ((updated ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (reversedSaleIds.length > 0) {
      const rev = await reverseConsignorPayoutsForSales(reversedSaleIds, userId, {
        reason: `shopify order ${target}`,
      });
      for (const e of rev.errors) result.errors.push(`consignor reversal: ${e}`);
    }
  }
  return result;
}

// Single entry point for an inbound order event (orders/create or orders/updated):
// a cancelled/refunded order updates sale status; an otherwise PAID order is
// ingested; anything else (pending/authorized) is skipped until it settles.
export async function handleShopifyOrderEvent(
  userId: string,
  order: ShopifyOrder,
): Promise<ShopifyOrderIngestResult & { kind: "ingest" | "status" | "skip" }> {
  if (refundStatusForOrder(order)) {
    return { kind: "status", ...(await applyShopifyOrderStatus(userId, order)) };
  }
  if ((order.financialStatus ?? "").toLowerCase() === "paid") {
    return { kind: "ingest", ...(await ingestShopifyOrder(userId, order)) };
  }
  return { kind: "skip", ...emptyResult() };
}

// Parses a Shopify webhook order payload into our normalized ShopifyOrder. The
// webhook body carries the same Order resource shape as the REST orders.json
// endpoint, so this mirrors listPaidOrders' mapping. Returns null when the
// payload has no usable order id.
export function parseShopifyWebhookOrder(
  payload: unknown,
): ShopifyOrder | null {
  const o = payload as {
    id?: number | string;
    name?: string;
    financial_status?: string;
    total_price?: string | number;
    processed_at?: string;
    created_at?: string;
    cancelled_at?: string | null;
    line_items?: Array<{
      product_id?: number | string | null;
      quantity?: number;
      price?: string | number;
    }>;
  } | null;
  if (!o || o.id == null) return null;
  return {
    id: String(o.id),
    name: o.name ?? "",
    financialStatus: o.financial_status ?? null,
    totalPrice: o.total_price != null ? Number(o.total_price) : 0,
    processedAt: o.processed_at ?? o.created_at ?? null,
    cancelledAt: o.cancelled_at ?? null,
    lineItems: (o.line_items ?? []).map((li) => ({
      productId: li.product_id != null ? String(li.product_id) : null,
      quantity: li.quantity ?? 1,
      price: li.price != null ? Number(li.price) : 0,
    })),
  };
}
