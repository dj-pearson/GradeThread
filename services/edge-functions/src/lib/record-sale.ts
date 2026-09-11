// US-3367: recording a sale, server-side.
//
// The Record Sale dialog used to write `sales`, `inventory_items` and
// `listings` straight from the browser and best-effort end the eBay listing.
// It never told autoEndCrossListings, so a sale recorded as "on Poshmark" left
// Mercari, Grailed and Vinted live until the seller remembered where else the
// garment was listed. Now the browser sends the facts and this module does
// every write, then hands off to the sibling planner every API order path
// already uses.
//
// TENANCY (US-268): the item and, when given, the listing are owner-checked
// before anything is written.

import { supabaseAdmin } from "./supabase.ts";
import {
  attemptUpstreamDelist,
  autoEndCrossListings,
  type SiblingRow,
} from "./cross-listings.ts";
import { delistMethodFor } from "./cross-listing-sale.ts";

export interface RecordSaleInput {
  inventory_item_id: string;
  /** The listing it sold through, or null for "somewhere else / in person". */
  listing_id: string | null;
  sale_price: number;
  shipping_collected: number;
  platform_fees: number;
  payment_processing_fees: number;
  shipping_cost: number;
  tax: number;
  other_costs: number;
  buyer_username: string | null;
  /** YYYY-MM-DD from the dialog, or null for today. */
  sale_date: string | null;
}

export interface RecordSaleResult {
  ok: true;
  sale_id: string;
  /** Siblings confirmed ended on their marketplace. */
  ended: number;
  /** Platforms whose delist is waiting on the seller's browser. */
  queued: string[];
  /** Platforms still live that need the seller to end them by hand. */
  unresolved: string[];
  nothing_live: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COST_KEYS = [
  "shipping_collected",
  "platform_fees",
  "payment_processing_fees",
  "shipping_cost",
  "tax",
  "other_costs",
] as const;
type CostKey = (typeof COST_KEYS)[number];

/**
 * The same formula the dialog previews. src/lib/sale-math.ts holds the client
 * copy and src/lib/__tests__/sale-math.test.ts pins the two by source.
 */
export function computeNetProfit(
  i: Pick<RecordSaleInput, "sale_price" | CostKey>,
  purchasePrice: number,
): number {
  return i.sale_price + i.shipping_collected - i.platform_fees -
    i.payment_processing_fees - i.shipping_cost - i.tax - i.other_costs - purchasePrice;
}

/** A multi-quantity listing only ends when the last unit sells (US-1424 AC3). */
export function planSoldListingUpdate(
  quantity: number | null,
): { quantity: number } | { listing_status: "sold"; is_active: false; quantity: 0 } {
  const remaining = Math.max(0, (quantity ?? 1) - 1);
  return remaining > 0
    ? { quantity: remaining }
    : { listing_status: "sold", is_active: false, quantity: 0 };
}

/** A number from a field value; absent is 0, unparseable is null. */
function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseRecordSaleBody(
  body: unknown,
): { ok: true; input: RecordSaleInput } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const itemId = typeof b.inventory_item_id === "string" && UUID.test(b.inventory_item_id)
    ? b.inventory_item_id
    : "";
  if (!itemId) return { ok: false, error: "inventory_item_id is required." };

  let listingId: string | null = null;
  if (b.listing_id != null && b.listing_id !== "") {
    if (typeof b.listing_id !== "string" || !UUID.test(b.listing_id)) {
      return { ok: false, error: "listing_id must be a listing id." };
    }
    listingId = b.listing_id;
  }

  const price = num(b.sale_price);
  if (price === null || price <= 0) {
    return { ok: false, error: "Enter a sale price greater than 0." };
  }
  const costs = {} as Record<CostKey, number>;
  for (const k of COST_KEYS) {
    const v = num(b[k]);
    if (v === null || v < 0) return { ok: false, error: "Fees and costs can't be negative." };
    costs[k] = v;
  }
  const saleDate = typeof b.sale_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.sale_date)
    ? b.sale_date
    : null;
  const buyer = typeof b.buyer_username === "string" ? b.buyer_username.trim().slice(0, 120) : "";

  return {
    ok: true,
    input: {
      inventory_item_id: itemId,
      listing_id: listingId,
      sale_price: price,
      ...costs,
      buyer_username: buyer || null,
      sale_date: saleDate,
    },
  };
}

interface OwnedListing {
  id: string;
  platform: string;
  listing_status: string;
  quantity: number | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  listing_url: string | null;
  inventory_item_id: string | null;
}

function toSibling(l: OwnedListing, ownerId: string, sku: string | null): SiblingRow {
  return {
    id: l.id,
    platform: l.platform,
    platform_offer_id: l.platform_offer_id,
    platform_listing_id: l.platform_listing_id,
    listing_status: l.listing_status,
    listing_url: l.listing_url,
    inventory_item_id: l.inventory_item_id,
    inventory_items: { user_id: ownerId, sku },
  };
}

export async function recordSale(
  ownerId: string,
  input: RecordSaleInput,
): Promise<{ status: number; body: RecordSaleResult | { error: string } }> {
  // `purchase_price` is an alias on the items_full VIEW; the table column the
  // dialog's cost basis comes from is acquired_price (00009).
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select("id, status, acquired_price, sku")
    .eq("id", input.inventory_item_id)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  const item = itemRow as
    | { id: string; status: string; acquired_price: number | null; sku: string | null }
    | null;
  if (!item) return { status: 404, body: { error: "Item not found." } };

  let sold: OwnedListing | null = null;
  if (input.listing_id) {
    const { data } = await supabaseAdmin
      .from("listings")
      .select(
        "id, platform, listing_status, quantity, platform_offer_id, platform_listing_id, " +
          "listing_url, inventory_item_id",
      )
      .eq("id", input.listing_id)
      .eq("inventory_item_id", item.id)
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    sold = data as OwnedListing | null;
    if (!sold) return { status: 404, body: { error: "Listing not found." } };
  }

  const saleDate = input.sale_date ?? new Date().toISOString().slice(0, 10);
  const { data: sale, error: saleErr } = await supabaseAdmin
    .from("sales")
    .insert({
      inventory_item_id: item.id,
      listing_id: sold?.id ?? null,
      sale_price: input.sale_price,
      shipping_collected: input.shipping_collected,
      platform_fees: input.platform_fees,
      payment_processing_fees: input.payment_processing_fees,
      shipping_cost: input.shipping_cost,
      tax: input.tax,
      other_costs: input.other_costs,
      net_profit: computeNetProfit(input, item.acquired_price ?? 0),
      buyer_username: input.buyer_username,
      sale_date: saleDate,
      sold_at: saleDate,
      status: "completed",
    })
    .select("id")
    .single();
  if (saleErr || !sale) {
    console.error("[record-sale] insert failed:", saleErr?.message ?? "no row");
    return { status: 500, body: { error: "Could not record the sale." } };
  }

  // The item advances to sold: the same write the client's advanceItemStatus
  // made, and a sale is the terminal status, so no rank check is needed.
  await supabaseAdmin
    .from("inventory_items")
    .update({ status: "sold" })
    .eq("id", item.id)
    .eq("user_id", ownerId); // US-268

  let ended = 0;
  const unresolved = new Set<string>();
  /** Listing ids whose siblings the planner should end. */
  const delistFrom: string[] = [];

  if (sold) {
    const patch = planSoldListingUpdate(sold.quantity);
    await supabaseAdmin
      .from("listings")
      .update(patch)
      .eq("id", sold.id)
      .eq("user_id", ownerId); // US-268
    if ("listing_status" in patch) {
      // The sold row itself, on an API channel: usually already ended by the
      // marketplace, and the classifier treats "already gone" as success.
      const method = delistMethodFor(sold.platform);
      if (method !== "extension" && method !== "unsupported") {
        const out = await attemptUpstreamDelist(ownerId, toSibling(sold, ownerId, item.sku));
        if (out.kind === "ended") ended++;
        else if (out.kind === "unresolved") unresolved.add(sold.platform);
      }
      delistFrom.push(sold.id);
    }
  } else {
    // Sold in person, or somewhere FlipDesk has no row for: every live listing
    // of the garment must come down. The first live row is marked sold so the
    // planner has an anchor; the rest are its siblings.
    const { data: live } = await supabaseAdmin
      .from("listings")
      .select("id")
      .eq("inventory_item_id", item.id)
      .eq("user_id", ownerId) // US-268
      .eq("listing_status", "active")
      .order("created_at", { ascending: true });
    const ids = ((live ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length > 0) {
      await supabaseAdmin
        .from("listings")
        .update({ listing_status: "sold", is_active: false, quantity: 0 })
        .eq("id", ids[0])
        .eq("user_id", ownerId); // US-268
      delistFrom.push(ids[0]);
    }
  }

  const queued = new Set<string>();
  let nothingLive = 0;
  for (const id of delistFrom) {
    const s = await autoEndCrossListings(ownerId, id);
    ended += s.ended;
    nothingLive += s.nothingLive;
  }

  // Names, not counts: the dialog says WHICH marketplaces the browser is about
  // to handle and which need the seller. Read back after the planner ran.
  if (delistFrom.length > 0) {
    const { data: rows } = await supabaseAdmin
      .from("listings")
      .select("id, platform, delist_requested_at, platform_fields")
      .eq("inventory_item_id", item.id)
      .eq("user_id", ownerId); // US-268
    for (
      const r of (rows ?? []) as {
        id: string;
        platform: string;
        delist_requested_at: string | null;
        platform_fields: Record<string, unknown> | null;
      }[]
    ) {
      if (delistFrom.includes(r.id)) continue;
      if (r.platform_fields?.delist_unresolved) unresolved.add(r.platform);
      else if (r.delist_requested_at) queued.add(r.platform);
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      sale_id: (sale as { id: string }).id,
      ended,
      queued: [...queued].sort(),
      unresolved: [...unresolved].sort(),
      nothing_live: nothingLive,
    },
  };
}
