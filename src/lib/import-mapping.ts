import type { ItemStatus, ItemCategory } from "@/types/database";

// FlipDesk fields the user can map a CSV column TO. "skip" excludes a column.
export const IMPORT_FIELDS = [
  "skip",
  "sku",
  "container",
  "title",
  "description",
  "brand",
  "style",
  "size",
  "condition_notes",
  "comps",
  "item_category",
  "source",
  "sourced_by",
  "purchase_date",
  "purchase_price",
  "list_date",
  "link",
  "list_price",
  "sale_date",
  "sale_price",
  "fees",
  "tax",
  "shipping_cost",
  "net_profit",
  "payout",
  "status",
  "tracking",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  skip: "— Skip —",
  sku: "Item # (SKU)",
  container: "Container",
  title: "Item Title",
  description: "Item Description",
  brand: "Brand",
  style: "Style",
  size: "Size",
  condition_notes: "Notes",
  comps: "Comps",
  item_category: "Category",
  source: "Source",
  sourced_by: "Sourced By",
  purchase_date: "Purchase Date",
  purchase_price: "Purchase Price",
  list_date: "List Date",
  link: "Link",
  list_price: "List Price",
  sale_date: "Sale Date",
  sale_price: "Sale Price",
  fees: "Fees",
  tax: "Tax",
  shipping_cost: "Shipping Cost",
  net_profit: "Net Profit",
  payout: "Payout",
  status: "Status",
  tracking: "Tracking",
};

// Best-guess mapping from a sheet header (any casing/spacing) to an ImportField.
export function guessField(header: string): ImportField {
  const key = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  const table: Record<string, ImportField> = {
    container: "container",
    item: "sku",
    itemnumber: "sku",
    itemno: "sku",
    sku: "sku",
    itemtitle: "title",
    title: "title",
    name: "title",
    itemdescription: "description",
    description: "description",
    desc: "description",
    brand: "brand",
    style: "style",
    model: "style",
    size: "size",
    notes: "condition_notes",
    note: "condition_notes",
    comps: "comps",
    comp: "comps",
    category: "item_category",
    cat: "item_category",
    source: "source",
    sourcedby: "sourced_by",
    purchasedate: "purchase_date",
    purchased: "purchase_date",
    purchaseprice: "purchase_price",
    cost: "purchase_price",
    listed: "skip", // boolean column — derived from list_date
    listdate: "list_date",
    listed_at: "list_date",
    links: "link",
    link: "link",
    url: "link",
    listprice: "list_price",
    saledate: "sale_date",
    sold: "sale_date",
    saleprice: "sale_price",
    soldprice: "sale_price",
    fees: "fees",
    fee: "fees",
    tax: "tax",
    shippingcost: "shipping_cost",
    shipping: "shipping_cost",
    netprofit: "net_profit",
    profit: "net_profit",
    payout: "payout",
    status: "status",
    daystosell: "skip", // computed
    tracking: "tracking",
    trackingnumber: "tracking",
  };
  return table[key] ?? "skip";
}

// Normalize free-text status strings ("Complete", "DRAFT", "Photo'd") to enum values.
export function normalizeStatus(raw: string): ItemStatus | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("photo")) return "photographed";
  if (s.startsWith("draft")) return "drafted";
  if (s.startsWith("list")) return "listed";
  if (s === "sold") return "sold";
  if (s.startsWith("ship")) return "shipped";
  if (s.startsWith("complet") || s === "done") return "completed";
  if (s.startsWith("return")) return "returned";
  if (s.startsWith("archiv")) return "archived";
  if (s.startsWith("keep")) return "keeping";
  if (s.startsWith("wear")) return "wearing";
  if (s.startsWith("source")) return "sourced";
  if (s.startsWith("acquir")) return "acquired";
  if (s.startsWith("catalog")) return "cataloged";
  if (s.startsWith("measur")) return "measured";
  if (s.startsWith("grad")) return "graded";
  if (s.startsWith("comp")) return "comped";
  return null;
}

const CATEGORY_HINTS: Record<string, ItemCategory> = {
  cloth: "clothing",
  shirt: "clothing",
  pant: "clothing",
  dress: "clothing",
  jacket: "clothing",
  short: "clothing",
  shoe: "shoes",
  sneaker: "shoes",
  boot: "shoes",
  watch: "watches",
  card: "sports_cards",
  collect: "collectibles",
  electronic: "electronics",
  book: "books",
};

export function normalizeCategory(raw: string): ItemCategory | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  for (const [hint, cat] of Object.entries(CATEGORY_HINTS)) {
    if (s.includes(hint)) return cat;
  }
  // Direct match against the enum
  if (
    ["clothing", "shoes", "watches", "sports_cards", "collectibles", "electronics", "books", "other"].includes(
      s,
    )
  ) {
    return s as ItemCategory;
  }
  return "other";
}

// Parse a price-ish cell ("$12.50", "12.5", "USD 12") to a number or null.
export function parsePrice(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Parse a date cell to ISO yyyy-mm-dd or null.
export function parseDate(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Try Date.parse first
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // M/D/YYYY or M/D/YY explicit fallback
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, mm, dd, yyRaw] = m;
    const yy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
    const iso = `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    if (!isNaN(new Date(iso).getTime())) return iso;
  }
  return null;
}
