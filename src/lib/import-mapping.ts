import type { ItemStatus, ItemCategory } from "@/types/database";
import { ITEM_CATEGORIES } from "@/lib/constants";

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
  // US-2797. Four enum values had no hint and no direct match, so a column
  // reading "Handbags" or "Baseball Cap" fell through to "other". Order
  // matters here: this object is walked in insertion order and the FIRST
  // substring hit wins, so these sit after the clothing hints - "jacket"
  // must still beat nothing, and "cap" must not steal "capri".
  hat: "headwear",
  beanie: "headwear",
  snapback: "headwear",
  handbag: "bags",
  purse: "bags",
  backpack: "bags",
  tote: "bags",
  jewel: "jewelry",
  ring: "jewelry",
  necklace: "jewelry",
  bracelet: "jewelry",
  earring: "jewelry",
};

export function normalizeCategory(raw: string): ItemCategory | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  for (const [hint, cat] of Object.entries(CATEGORY_HINTS)) {
    if (s.includes(hint)) return cat;
  }
  // Direct match against the enum. US-2797: this used to be a hand-written
  // copy of the values, and it was three enum widenings behind - jewelry,
  // bags and accessories (00230) and headwear (00570) all fell through to
  // "other". Reading the source list is what stops that recurring.
  if ((ITEM_CATEGORIES as readonly string[]).includes(s)) {
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
//
// IMPORTANT: numeric "M/D" and "M/D/Y" forms are handled by an explicit regex
// BEFORE falling back to `new Date()`. Year-less values like "1/25" must never
// reach `new Date("1/25")` — V8 silently resolves those to the year 2001
// (e.g. "2001-01-25"), which is how reseller sheets that list dates as bare
// "M/D" ended up with year-2001 list_date values and absurd days_to_sell
// (sale_date − list_date ≈ 9000+ days). When the year is omitted we infer the
// most recent occurrence of that month/day at or before `referenceDate`.
export function parseDate(raw: string, referenceDate: Date = new Date()): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Numeric M/D or M/D/Y (slash- or dash-separated). Matched first so a
  // year-less value can't hit the `new Date()` year-2001 quirk.
  const md = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (md) {
    const mm = Number(md[1]);
    const dd = Number(md[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    let year: number;
    if (md[3]) {
      year = md[3].length === 2 ? 2000 + Number(md[3]) : Number(md[3]);
    } else {
      // Year omitted: assume the most recent occurrence at or before the
      // reference date (this year, or last year if that date is still ahead).
      year = referenceDate.getFullYear();
      if (new Date(year, mm - 1, dd).getTime() > referenceDate.getTime()) {
        year -= 1;
      }
    }
    const iso = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    // Reject impossible calendar dates (e.g. 2/30) — new Date() normalizes
    // those by rolling over, so compare the round-trip back to the input.
    const check = new Date(`${iso}T00:00:00Z`);
    if (isNaN(check.getTime()) || check.getUTCMonth() + 1 !== mm || check.getUTCDate() !== dd) {
      return null;
    }
    return iso;
  }

  // Full date strings that carry an explicit year (ISO, "Jan 25, 2026", etc.).
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
}
