import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { rankShipQueue } from "@/pages/flipdesk/ship-queue";

// US-3190: the orders waiting to go in a box, soonest deadline first.
//
// RLS scopes every read here to the caller, so no tenant filter is written by
// hand — the same rule use-case-items.ts follows. The edge does not serve this:
// it is a plain read of the seller's own rows, and routing it through a function
// would add a hop and an auth header to a query Postgres already answers.
//
// ── WHAT COUNTS AS WAITING ──────────────────────────────────────────────────
//
// status = 'completed' AND shipped_at IS NULL. A cancelled or refunded order is
// not waiting on a box, and the seller marking it shipped is what removes it —
// the same field the eBay ship route writes, so an order shipped from either
// surface leaves the queue.

export interface ShipQueueRow {
  /** sales.id */
  id: string;
  /** The marketplace order reference, for the packing slip and the eBay link. */
  orderRef: string | null;
  /** ISO ship-by instant, or null when no marketplace reported one. */
  shipBy: string | null;
  soldAt: string | null;
  buyerUsername: string | null;
  salePrice: number | null;
  inventoryItemId: string;
  title: string | null;
  sku: string | null;
  size: string | null;
  /** Where the garment is on the shelf. The one field that saves a walk. */
  locationBin: string | null;
  /** US-3205: the tote or bin the garment was filed into at intake. Distinct
   *  from locationBin, which is the shelf position; sellers who tote by haul
   *  find the item by container first and the shelf second. */
  container: string | null;
  /** The marketplace listing, for checking what the buyer actually saw. */
  listingUrl: string | null;
  /** What this garment cost to acquire (sale_pnl.cost_basis). */
  costBasis: number | null;
  /**
   * Profit on this sale (sale_pnl.net), which is REVENUE MINUS FEES, COSTS AND
   * COST BASIS — the same arithmetic finances_dashboard uses, read from the
   * view rather than recomputed here so the prep queue and the P&L page cannot
   * disagree about one sale.
   *
   * PROVISIONAL ON THIS SCREEN, and the UI says so. Every row in this queue is
   * unshipped by definition, so the label has not been bought and its cost is
   * not in `costs` yet. The number moves once it is.
   */
  net: number | null;
  /** US-3191: the grade and its certificate, for the packing slip. Null when ungraded. */
  gradeValue: number | null;
  gradeLabel: string | null;
  certificateUrl: string | null;
  quantity: number | null;
}

interface SaleQueryRow {
  id: string;
  platform_order_id: string | null;
  ship_by: string | null;
  sold_at: string | null;
  sale_date: string | null;
  buyer_username: string | null;
  sale_price: number | null;
  quantity: number | null;
  inventory_item_id: string;
}

interface ItemQueryRow {
  id: string;
  title: string | null;
  sku: string | null;
  size: string | null;
  location_bin: string | null;
  container: string | null;
  grade_value: number | null;
  grade_label: string | null;
  certificate_url: string | null;
}

interface PnlQueryRow {
  sale_id: string;
  cost_basis: number | null;
  net: number | null;
}

interface ListingQueryRow {
  inventory_item_id: string;
  listing_url: string | null;
  platform_listing_id: string | null;
}

/**
 * How many ids may go into one PostgREST `in.(...)` filter (US-3298).
 *
 * The gateway in front of PostgREST rejects a request line over 8 KB, and it
 * does so BEFORE any CORS header is written — so the browser reports "blocked
 * by CORS policy", names no status, and points at the wrong problem entirely.
 *
 * Measured against production on 2026-09-09 with this exact query: 205 ids is a
 * URL of 8,088 characters and returns 200; 210 ids is 8,283 characters and
 * fails outright. A UUID costs 39 characters once supabase-js percent-encodes
 * the separating comma, so the cliff sits a little over 200 and the account
 * that found it had 210 unshipped sales. Nothing was broken at 150.
 *
 * 100 is half the proven limit, which leaves room for a longer select list or
 * a second filter without anyone having to redo the arithmetic. The queue reads
 * up to 500 sales, so this is a real split rather than a formality.
 *
 * It fails QUIETLY, which is the reason to fix it rather than raise a cap: both
 * of these reads are best-effort by design, so the seller sees a ship queue
 * with the money columns blank and no indication that anything went wrong.
 */
export const IN_FILTER_CHUNK = 100;

/** Runs `read` over `values` in {@link IN_FILTER_CHUNK}-sized slices, concatenated. */
export async function inChunks<T>(
  values: string[],
  read: (slice: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += IN_FILTER_CHUNK) {
    out.push(...(await read(values.slice(i, i + IN_FILTER_CHUNK))));
  }
  return out;
}

/** Orders sold and not yet shipped, ranked by deadline. */
export function useShipQueue(enabled = true) {
  const query = useQuery({
    queryKey: ["ship_queue"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ShipQueueRow[]> => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id, platform_order_id, ship_by, sold_at, sale_date, buyer_username, sale_price, quantity, inventory_item_id",
        )
        .eq("status", "completed")
        .is("shipped_at", null)
        .order("ship_by", { ascending: true, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      const sales = ((data ?? []) as unknown) as SaleQueryRow[];
      if (sales.length === 0) return [];

      const itemIds = [...new Set(sales.map((s) => s.inventory_item_id).filter(Boolean))];
      const itemData = await inChunks(itemIds, async (slice) => {
        const { data, error: itemErr } = await supabase
          .from("inventory_items")
          .select(
            "id, title, sku, size, location_bin, container, grade_value, grade_label, certificate_url",
          )
          .in("id", slice);
        if (itemErr) throw itemErr;
        return ((data ?? []) as unknown) as ItemQueryRow[];
      });
      const items = new Map(itemData.map((i) => [i.id, i]));

      // US-3205: money from sale_pnl, never recomputed here.
      //
      // The per-sale net exists in exactly one place that is safe to read —
      // this view (00706), which carries finances_dashboard's derivation to the
      // cent including the legacy shipments extra. Adding revenue minus fees in
      // this hook would have been a fourth copy of that arithmetic and the one
      // most likely to drift, because nothing reconciles a prep screen.
      //
      // Both extra reads are best effort: a prep queue that shows the shelf and
      // the deadline is still worth rendering if the money is unavailable, so a
      // failure here leaves the columns blank rather than emptying the queue.
      const saleIds = sales.map((s) => s.id);
      const pnlById = new Map<string, PnlQueryRow>();
      try {
        const pnlData = await inChunks(saleIds, async (slice) => {
          const { data, error: pnlErr } = await supabase
            .from("sale_pnl")
            .select("sale_id, cost_basis, net")
            .in("sale_id", slice);
          if (pnlErr) throw pnlErr;
          return ((data ?? []) as unknown) as PnlQueryRow[];
        });
        for (const r of pnlData) pnlById.set(r.sale_id, r);
      } catch (err) {
        console.warn("[ship-queue] sale_pnl unavailable:", (err as Error).message);
      }

      // The listing the buyer actually bought from. Most recent first, so an
      // item relisted after a cancellation links to the live one.
      const linkByItem = new Map<string, string>();
      try {
        const listingData = await inChunks(itemIds, async (slice) => {
          const { data, error: listingErr } = await supabase
            .from("listings")
            .select("inventory_item_id, listing_url, platform_listing_id")
            .in("inventory_item_id", slice)
            .order("listed_at", { ascending: false, nullsFirst: false });
          if (listingErr) throw listingErr;
          return ((data ?? []) as unknown) as ListingQueryRow[];
        });
        for (const r of listingData) {
          if (!r.inventory_item_id || linkByItem.has(r.inventory_item_id)) continue;
          const url = (r.listing_url ?? "").trim() ||
            (r.platform_listing_id
              ? `https://www.ebay.com/itm/${r.platform_listing_id}`
              : "");
          if (url) linkByItem.set(r.inventory_item_id, url);
        }
      } catch (err) {
        console.warn("[ship-queue] listing links unavailable:", (err as Error).message);
      }

      return sales.map((s) => {
        const item = items.get(s.inventory_item_id) ?? null;
        return {
          id: s.id,
          orderRef: s.platform_order_id,
          shipBy: s.ship_by,
          soldAt: s.sold_at ?? s.sale_date ?? null,
          buyerUsername: s.buyer_username,
          salePrice: s.sale_price,
          inventoryItemId: s.inventory_item_id,
          title: item?.title ?? null,
          sku: item?.sku ?? null,
          size: item?.size ?? null,
          locationBin: item?.location_bin ?? null,
          container: item?.container ?? null,
          listingUrl: linkByItem.get(s.inventory_item_id) ?? null,
          costBasis: pnlById.get(s.id)?.cost_basis ?? null,
          net: pnlById.get(s.id)?.net ?? null,
          gradeValue: item?.grade_value ?? null,
          gradeLabel: item?.grade_label ?? null,
          certificateUrl: item?.certificate_url ?? null,
          quantity: s.quantity,
        };
      });
    },
  });

  // Postgres orders nulls last for us, but the rank is re-applied in JS so the
  // page and the needs-you merge cannot drift on what "soonest" means.
  const rows = useMemo(() => rankShipQueue(query.data ?? []), [query.data]);

  return { ...query, rows };
}
