// The item's structured attributes, read once for a whole batch.
//
// Extracted from autolister-bulk-edit.tsx under the US-2520 shrink-only
// ratchet, which says in as many words to move a piece out rather than raise
// the ceiling. US-2790's margin-floor fix needed two more columns and pushed
// the page over; this is the piece that left.
//
// These back the placeholders in the grid: when a row's Brand/Size/Color
// override is empty, the server derives the aspect from these columns, so
// showing them tells the seller what will actually be used.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { ParcelGarmentCategory } from "@/lib/parcel-estimate";

export type ItemAttrs = {
  title: string;
  brand: string;
  size: string;
  color: string;
  material: string;
  style: string;
  itemCategory: string | null;
  attributes: Record<string, string | string[]> | null;
  /** US-553: cost basis (acquired_price) backs the forward P&L / margin column. */
  cost: number | null;
  /** US-2790: what the parcel estimator reads. */
  garmentCategory: ParcelGarmentCategory | null;
  measurements: Record<string, number | string> | null;
};

interface Row {
  id: string;
  title: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  style: string | null;
  item_category: string | null;
  attributes: Record<string, string | string[]> | null;
  acquired_price: number | null;
  garment_category: ParcelGarmentCategory | null;
  measurements: Record<string, number | string> | null;
}

export function useItemAttrs(batchId: string | null, itemIds: string[]) {
  return useQuery<Record<string, ItemAttrs>>({
    queryKey: ["autolister_bulk_item_attrs", batchId, itemIds.length],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("inventory_items")
        .select(
          "id, title, brand, size, color, material, style, item_category, attributes, acquired_price, garment_category, measurements",
        )
        .in("id", itemIds);
      const map: Record<string, ItemAttrs> = {};
      for (const r of (rows ?? []) as Row[]) {
        map[r.id] = {
          title: r.title ?? "",
          brand: r.brand ?? "",
          size: r.size ?? "",
          color: r.color ?? "",
          material: r.material ?? "",
          style: r.style ?? "",
          itemCategory: r.item_category,
          attributes: r.attributes,
          cost: r.acquired_price,
          garmentCategory: r.garment_category,
          measurements: r.measurements,
        };
      }
      return map;
    },
  });
}
