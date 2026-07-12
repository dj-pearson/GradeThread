import type {
  ItemComp,
  ItemStatus,
  ItemCategory,
  InventoryItemRow,
} from "@/types/database";

// The form-shaped values compared during a duplicate-SKU merge. Matches the
// editable fields of the item canvas (everything the user can resolve); non-UI
// columns (grade linkage, eBay taxonomy, …) are coalesced server-side by the
// merge_inventory_items RPC. Lives here (not in the dialog component) so the
// mapper below can be shared without breaking React Fast Refresh.
export interface MergeValues {
  title: string;
  container: string;
  brand: string;
  style: string;
  size: string;
  color: string;
  material: string;
  description: string;
  condition_notes: string;
  item_category: ItemCategory | "";
  sourced_by: string;
  status: ItemStatus;
  acquired_date: string;
  acquired_price: string;
  target_price: string;
  comp_set: ItemComp[];
  measurements: Record<string, number | string>;
}

// Form-shaped view of a raw inventory_items row, for the duplicate-SKU merge
// comparison (same string conventions as the item canvas's EditState). Shared
// by both merge entry points (the item page and the composer).
export function rowToMergeValues(row: InventoryItemRow): MergeValues {
  return {
    title: row.title ?? "",
    container: row.container ?? "",
    brand: row.brand ?? "",
    style: row.style ?? "",
    size: row.size ?? "",
    color: row.color ?? "",
    material: row.material ?? "",
    description: row.description ?? "",
    condition_notes: row.condition_notes ?? "",
    item_category: row.item_category ?? "",
    sourced_by: row.sourced_by ?? "",
    status: row.status,
    acquired_date: row.acquired_date?.slice(0, 10) ?? "",
    acquired_price:
      row.acquired_price == null ? "" : String(row.acquired_price),
    target_price: row.target_price == null ? "" : String(row.target_price),
    comp_set: Array.isArray(row.comp_set) ? row.comp_set : [],
    measurements:
      row.measurements && typeof row.measurements === "object"
        ? row.measurements
        : {},
  };
}
