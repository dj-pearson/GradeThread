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
}

interface SaleQueryRow {
  id: string;
  platform_order_id: string | null;
  ship_by: string | null;
  sold_at: string | null;
  sale_date: string | null;
  buyer_username: string | null;
  sale_price: number | null;
  inventory_item_id: string;
}

interface ItemQueryRow {
  id: string;
  title: string | null;
  sku: string | null;
  size: string | null;
  location_bin: string | null;
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
          "id, platform_order_id, ship_by, sold_at, sale_date, buyer_username, sale_price, inventory_item_id",
        )
        .eq("status", "completed")
        .is("shipped_at", null)
        .order("ship_by", { ascending: true, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      const sales = ((data ?? []) as unknown) as SaleQueryRow[];
      if (sales.length === 0) return [];

      const itemIds = [...new Set(sales.map((s) => s.inventory_item_id).filter(Boolean))];
      const { data: itemData, error: itemErr } = await supabase
        .from("inventory_items")
        .select("id, title, sku, size, location_bin")
        .in("id", itemIds);
      if (itemErr) throw itemErr;
      const items = new Map(
        (((itemData ?? []) as unknown) as ItemQueryRow[]).map((i) => [i.id, i]),
      );

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
        };
      });
    },
  });

  // Postgres orders nulls last for us, but the rank is re-applied in JS so the
  // page and the needs-you merge cannot drift on what "soonest" means.
  const rows = useMemo(() => rankShipQueue(query.data ?? []), [query.data]);

  return { ...query, rows };
}
