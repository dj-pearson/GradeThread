import type { ItemFullRow, ListingRow } from "@/types/database";
import { deriveListingOrigin } from "@/lib/listing-origin";
import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";

export type GridListing = Pick<ListingRow,
  "id" | "inventory_item_id" | "platform" | "listing_status" |
  "listing_origin" | "platform_listing_id" | "batch_id" | "synced_to_ebay_at" |
  "listing_title" | "listing_price" | "quantity" | "platform_category_id" |
  "ebay_condition" | "ebay_condition_description" | "shipping_policy_id" |
  "payment_policy_id" | "return_policy_id" | "item_specifics_override" |
  "item_specifics_sources" | "variations"
>;
export type GridRow = ItemFullRow & { listing?: GridListing; listingError?: string };
export type GridGroup = "Inventory" | "Listing" | "Shipping & returns" | "Item specifics";
export interface GridCol {
  key: string;
  label: string;
  field: string;
  group: GridGroup;
  width: number;
  numeric?: boolean;
  integer?: boolean;
  required?: boolean;
  maxLength?: number;
  options?: { value: string; label: string }[];
  policy?: "fulfillment" | "payment" | "return";
  get: (row: GridRow) => string;
}
const string = (value: unknown) => value == null ? "" : String(value);
const item = (field: string, key: keyof ItemFullRow, label: string, width = 150, numeric = false): GridCol => ({
  key: field, field, label, width, numeric, group: "Inventory", get: row => string(row[key]),
});
const listing = (field: keyof GridListing, label: string, width = 170): GridCol => ({
  key: `listing.${field}`, field: `listing.${field}`, label, width, group: "Listing",
  get: row => string(row.listing?.[field]),
});

export const GRID_COLS: GridCol[] = [
  item("sku", "item_number", "SKU", 140),
  { ...item("title", "item_title", "Inventory title", 280), required: true },
  { ...listing("listing_title", "Listing title", 320), required: true, maxLength: 80 },
  { ...listing("listing_price", "Listing price", 140), numeric: true, required: true },
  { ...listing("quantity", "Quantity", 110), numeric: true, integer: true, required: true },
  item("brand", "brand", "Brand"),
  item("style", "style", "Style"),
  item("size", "size", "Size", 100),
  item("color", "color", "Color"),
  item("material", "material", "Material", 190),
  { ...listing("ebay_condition", "eBay condition", 200), required: true,
    options: EBAY_CONDITION_OPTIONS.map(option => ({ value: option.value, label: option.label })) },
  { ...listing("ebay_condition_description", "Condition description", 320), maxLength: 1000 },
  { ...listing("platform_category_id", "eBay category ID", 170), required: true },
  ...([
    ["shipping_policy_id", "Shipping policy", "fulfillment"],
    ["return_policy_id", "Return policy", "return"],
    ["payment_policy_id", "Payment policy", "payment"],
  ] as const).map(([field, label, policy]): GridCol => ({
    ...listing(field, label, 230), group: "Shipping & returns", policy, required: true,
  })),
  item("acquired_price", "purchase_price", "Cost", 120, true),
  item("target_price", "target_price", "Target price", 130, true),
  item("floor_price", "floor_price", "Floor price", 130, true),
  item("location_bin", "location_bin", "Storage bin"),
  item("sourced_by", "sourced_by", "Sourced by", 170),
  item("condition_notes", "notes", "Private notes", 300),
];

export function aspectColumn(name: string): GridCol {
  return {
    key: `aspect.${name}`, field: `aspect.${name}`, label: name,
    group: "Item specifics", width: 190, maxLength: 200,
    get: row => (row.listing?.item_specifics_override?.[name] ?? []).join("; "),
  };
}
export const COMMON_ASPECTS = ["Department", "Type", "Size Type", "Fit", "Pattern", "Sleeve Length", "Neckline", "Fabric Type"];
export const DEFAULT_GRID_KEYS = ["sku", "listing.listing_title", "listing.listing_price", "listing.quantity", "brand", "size", "listing.ebay_condition"];
export const INVENTORY_GRID_KEYS = ["sku", "title", "brand", "style", "size", "color", "material", "acquired_price", "target_price", "floor_price", "location_bin", "sourced_by", "condition_notes"];
export const GRID_GROUPS: GridGroup[] = ["Inventory", "Listing", "Shipping & returns", "Item specifics"];
export const isListingColumn = (col: GridCol) => col.group !== "Inventory";

export function cellLock(row: GridRow, col: GridCol): string | null {
  if (!isListingColumn(col)) return null;
  if (row.listingError) return row.listingError;
  if (!row.listing) return "Create a draft for this item before editing listing fields.";
  if (row.listing.platform !== "ebay") return "Open this item's editor to change its marketplace listing.";
  if (deriveListingOrigin(row.listing) === "ebay") return "Created on eBay. Edit these listing fields on eBay.";
  if (!["draft", "active"].includes(row.listing.listing_status)) return "Only draft and active listings can be revised here.";
  if (row.listing.variations && (col.numeric || col.field === "sku")) return "Edit variation prices and quantities in the item editor.";
  return null;
}

export function validateGridValue(col: GridCol, raw: string, row?: GridRow): string | null {
  const value = raw.trim();
  if (col.required && !value) return `${col.label} is required.`;
  if (col.maxLength && value.length > col.maxLength) return `Use ${col.maxLength} characters or fewer.`;
  if (col.numeric && value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "Enter a number of zero or more.";
    if (col.integer && !Number.isInteger(n)) return "Enter a whole number.";
    if (!col.integer && Math.abs(n * 100 - Math.round(n * 100)) > 0.000001) return "Use at most two decimal places.";
    if (col.field === "listing.listing_price" && n <= 0) return "Listing price must be greater than zero.";
    if (col.field === "listing.listing_price" && row?.floor_price != null && n < row.floor_price) return `Price must be at least the floor of ${row.floor_price.toFixed(2)}.`;
  }
  if (col.field === "listing.platform_category_id" && !/^\d+$/.test(value)) return "Enter an eBay category ID made of digits.";
  if (col.options && value && !col.options.some(option => option.value === value)) return "Choose a value from the list.";
  return null;
}
