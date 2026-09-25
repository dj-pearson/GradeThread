import type { ItemStatus, ItemCategory } from "@/types/database";
import { ITEM_CATEGORIES } from "@/lib/constants";
import { toLocalDate } from "@/lib/local-date";

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
  "marketplace",
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
  marketplace: "Marketplace",
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

// Header synonyms per field. A header is lowercased with everything but
// letters and digits removed before the lookup, so "Item #", "item_no" and
// "ITEM NO." all read the same. IMP-11: built from a list per field rather
// than one flat table, so a synonym cannot be written under a key the
// normalization can never produce (the old table had `listed_at`, which no
// header could ever match).
const FIELD_SYNONYMS: Array<[ImportField, string[]]> = [
  ["container", ["container", "bin", "location", "shelf"]],
  ["sku", ["item", "itemnumber", "itemno", "sku", "itemid", "customlabel", "customlabelsku"]],
  ["title", ["itemtitle", "title", "name", "itemname", "listingtitle"]],
  ["description", ["itemdescription", "description", "desc"]],
  ["brand", ["brand", "maker", "designer"]],
  ["style", ["style", "model"]],
  ["size", ["size"]],
  ["condition_notes", ["notes", "note", "condition", "conditionnotes"]],
  ["comps", ["comps", "comp"]],
  ["item_category", ["category", "cat", "type"]],
  ["source", ["source", "sourcedfrom", "store"]],
  ["sourced_by", ["sourcedby"]],
  ["purchase_date", ["purchasedate", "purchased", "datepurchased", "acquireddate", "buydate"]],
  ["purchase_price", ["purchaseprice", "cost", "cogs", "costofgoods", "paid", "buyprice", "costprice"]],
  ["list_date", ["listdate", "listedat", "listeddate", "datelisted"]],
  ["link", ["links", "link", "url", "listingurl", "listinglink"]],
  ["marketplace", ["platform", "marketplace", "channel"]],
  ["list_price", ["listprice", "price", "askingprice", "listingprice", "currentprice"]],
  ["sale_date", ["saledate", "sold", "datesold", "solddate", "soldon"]],
  ["sale_price", ["saleprice", "soldprice", "soldfor", "sellingprice"]],
  ["fees", ["fees", "fee", "sellingfees", "platformfees"]],
  ["tax", ["tax", "salestax"]],
  ["shipping_cost", ["shippingcost", "shipping", "postage"]],
  ["net_profit", ["netprofit", "profit"]],
  ["payout", ["payout", "netpayout", "earnings"]],
  ["status", ["status", "itemstatus", "state"]],
  ["tracking", ["tracking", "trackingnumber"]],
  // Columns a tracker computes; importing them would only be stale copies.
  ["skip", ["listed", "daystosell"]],
];

const HEADER_TABLE: Record<string, ImportField> = Object.fromEntries(
  FIELD_SYNONYMS.flatMap(([field, keys]) => keys.map((k) => [k, field])),
);

// Best-guess mapping from a sheet header (any casing/spacing) to an ImportField.
export function guessField(header: string): ImportField {
  const key = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  return HEADER_TABLE[key] ?? "skip";
}

// IMP-08: the listing_platform values a Marketplace column can name. Anything
// else is sent as nothing, and the server infers from the URL or uses 'other'.
const MARKETPLACE_ALIASES: Record<string, string> = {
  ebay: "ebay",
  poshmark: "poshmark",
  posh: "poshmark",
  mercari: "mercari",
  depop: "depop",
  grailed: "grailed",
  etsy: "etsy",
  shopify: "shopify",
  vinted: "vinted",
  whatnot: "whatnot",
  facebook: "facebook",
  facebookmarketplace: "facebook",
  fb: "facebook",
  fbmp: "facebook",
  offerup: "offerup",
  other: "other",
};

export function normalizeMarketplace(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  return MARKETPLACE_ALIASES[key] ?? null;
}

// Normalize free-text status strings ("Complete", "DRAFT", "Photo'd") to enum values.
export function normalizeStatus(raw: string): ItemStatus | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // IMP-11: what other trackers and marketplaces call these.
  if (s.startsWith("unlist") || s === "inactive" || s === "not listed") return "drafted";
  if (
    s === "active" || s === "available" || s === "for sale" ||
    s === "in stock" || s === "live" || s === "on sale"
  ) {
    return "listed";
  }
  if (s.startsWith("sold")) return "sold";
  if (s.startsWith("photo")) return "photographed";
  if (s.startsWith("draft")) return "drafted";
  if (s.startsWith("list")) return "listed";
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

// IMP-11: whole words, not substrings. First-substring-wins sent "Cardigan"
// to sports cards ("card") and "Bootcut Jeans" to shoes ("boot"). Each word is
// tried as written and with a plural "es" or "s" removed.
const CATEGORY_WORDS: Record<string, ItemCategory> = {
  cloth: "clothing",
  clothe: "clothing",
  clothing: "clothing",
  shirt: "clothing",
  tshirt: "clothing",
  tee: "clothing",
  pant: "clothing",
  jean: "clothing",
  dress: "clothing",
  jacket: "clothing",
  short: "clothing",
  sweater: "clothing",
  sweatshirt: "clothing",
  hoodie: "clothing",
  coat: "clothing",
  skirt: "clothing",
  top: "clothing",
  blouse: "clothing",
  cardigan: "clothing",
  blazer: "clothing",
  vest: "clothing",
  legging: "clothing",
  shoe: "shoes",
  sneaker: "shoes",
  boot: "shoes",
  heel: "shoes",
  sandal: "shoes",
  loafer: "shoes",
  watch: "watches",
  card: "sports_cards",
  collectible: "collectibles",
  collectable: "collectibles",
  electronic: "electronics",
  book: "books",
  hat: "headwear",
  cap: "headwear",
  beanie: "headwear",
  snapback: "headwear",
  handbag: "bags",
  purse: "bags",
  backpack: "bags",
  tote: "bags",
  bag: "bags",
  jewel: "jewelry",
  jewelry: "jewelry",
  jewellery: "jewelry",
  ring: "jewelry",
  necklace: "jewelry",
  bracelet: "jewelry",
  earring: "jewelry",
  belt: "accessories",
  scarf: "accessories",
  scarve: "accessories",
  wallet: "accessories",
  sunglass: "accessories",
  tie: "accessories",
  glove: "accessories",
  accessory: "accessories",
  accessorie: "accessories",
};

function categoryForWord(word: string): ItemCategory | null {
  for (const w of [word, word.replace(/es$/, ""), word.replace(/s$/, "")]) {
    const hit = CATEGORY_WORDS[w];
    if (hit) return hit;
  }
  return null;
}

export function normalizeCategory(raw: string): ItemCategory | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // Direct match against the enum first. US-2797: reading the source list is
  // what stops this falling three enum widenings behind again.
  const snake = s.replace(/[\s-]+/g, "_");
  if ((ITEM_CATEGORIES as readonly string[]).includes(snake)) {
    return snake as ItemCategory;
  }
  // The head noun of an English phrase comes last ("Dress Shoes" is shoes,
  // "Baseball Cap" is headwear), so walk the words from the end.
  const words = s.split(/[^a-z]+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const hit = categoryForWord(words[i]!);
    if (hit) return hit;
  }
  return "other";
}

// IMP-11: a column whose amounts are written "12,50" uses a decimal comma.
// Only when some cell looks like that and none looks like "12.50", so a US
// column with "1,200" thousands separators is never read as 1.2.
export function detectDecimalComma(cells: readonly string[]): boolean {
  let comma = false;
  for (const c of cells) {
    const t = c.trim();
    if (/\d\.\d{2}$/.test(t)) return false;
    if (/\d,\d{2}$/.test(t)) comma = true;
  }
  return comma;
}

// Parse a price-ish cell ("$12.50", "12.5", "USD 12", "(4.00)") to a number or
// null. `decimalComma` is the per-column hint from detectDecimalComma.
export function parsePrice(
  raw: string,
  opts: { decimalComma?: boolean } = {},
): number | null {
  if (!raw) return null;
  let s = raw.trim();
  // Accounting negatives: (4.00) is -4.00.
  const negative = /^\(.*\)$/.test(s);
  if (negative) s = s.slice(1, -1);
  s = opts.decimalComma
    ? s.replace(/[.\s]/g, "").replace(/,/g, ".")
    : s.replace(/,/g, "");
  const cleaned = s.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

// IMP-11: a numeric date column is day-first when some cell's first part
// cannot be a month (over 12) and no cell's second part is over 12.
export function detectDayFirst(cells: readonly string[]): boolean {
  let dayFirst = false;
  for (const c of cells) {
    const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?$/.exec(c.trim());
    if (!m) continue;
    if (Number(m[2]) > 12) return false;
    if (Number(m[1]) > 12) dayFirst = true;
  }
  return dayFirst;
}

// Excel stores a date as days since 1899-12-30. A bare integer in this range
// (1954-10-03 to 2064-04-08) in a date column is one of those.
const EXCEL_SERIAL_MIN = 20000;
const EXCEL_SERIAL_MAX = 60000;

/** Two-digit years: 00 up to next year are 20xx, the rest 19xx. */
function pivotYear(yy: number, referenceDate: Date): number {
  const candidate = 2000 + yy;
  return candidate > referenceDate.getFullYear() + 1 ? 1900 + yy : candidate;
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
export function parseDate(
  raw: string,
  referenceDate: Date = new Date(),
  opts: { dayFirst?: boolean } = {},
): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // IMP-11: an Excel serial date that lost its formatting on export.
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n >= EXCEL_SERIAL_MIN && n <= EXCEL_SERIAL_MAX) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    return null;
  }

  // Numeric M/D or M/D/Y (slash- or dash-separated). Matched first so a
  // year-less value can't hit the `new Date()` year-2001 quirk.
  const md = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (md) {
    // IMP-11: a day-first column (25/01/2026) reads the other way round.
    const mm = Number(opts.dayFirst ? md[2] : md[1]);
    const dd = Number(opts.dayFirst ? md[1] : md[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    let year: number;
    if (md[3]) {
      year = md[3].length === 2 ? pivotYear(Number(md[3]), referenceDate) : Number(md[3]);
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
  //
  // US-3247: this read the UTC calendar day off the parsed Date. "Jan 25, 2026"
  // parses to LOCAL midnight, so anywhere ahead of UTC -- British Summer Time
  // through UTC+13 -- that returned the 24th. The US is behind UTC, which is
  // why it survived: the dates only moved for sellers nobody here was testing
  // as. Acquisition and sale dates feed the P&L, the fiscal-year window and the
  // tax packet, so a 1 January purchase could import into the previous tax
  // year.
  //
  // But reading the LOCAL day off everything is the same mistake mirrored: a
  // DATE-ONLY ISO string ("2026-01-01") parses as UTC midnight, so taking its
  // local day returns 2025-12-31 for the whole of the Americas. That is the
  // wrong half of the fix and it would hit far more sellers than the bug did.
  //
  // The two are different kinds of value. A date-only string is already a
  // calendar day and carries no timezone, so it passes through untouched.
  // Anything else parses to an instant, and the day a human means by it is the
  // local one.
  const dateOnly = /^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/.exec(s);
  if (dateOnly) {
    const iso = dateOnly[1]!;
    const probe = new Date(`${iso}T00:00:00Z`);
    return isNaN(probe.getTime()) ? null : iso;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return toLocalDate(d);

  return null;
}

// ── IMP-12: the payload and the dry run, as pure functions ─────────────────
//
// The page used to build these inline, so the only way to learn that three
// rows had no title or two dates were unreadable was to import and read the
// error list. The same functions now build what is sent AND the summary shown
// before anything is saved, so the two cannot disagree.

/** Must equal MAX_IMPORT_ROWS in services/edge-functions/src/lib/inventory-import.ts. */
export const MAX_IMPORT_ROWS = 5000;

export type MappedRow = Partial<Record<ImportField, string>>;

export function buildMapped(
  row: readonly string[],
  headers: readonly string[],
  mapping: readonly ImportField[],
): MappedRow {
  const result: MappedRow = {};
  for (let i = 0; i < headers.length; i++) {
    const field = mapping[i];
    const value = row[i];
    if (!field || field === "skip" || !value) continue;
    result[field] = value.trim();
  }
  return result;
}

const PRICE_FIELDS = [
  "purchase_price",
  "list_price",
  "sale_price",
  "fees",
  "tax",
  "shipping_cost",
  "net_profit",
  "payout",
] as const satisfies readonly ImportField[];

const DATE_FIELDS = ["purchase_date", "list_date", "sale_date"] as const satisfies readonly ImportField[];

export interface ImportColumnHints {
  decimalComma: Partial<Record<ImportField, boolean>>;
  dayFirst: Partial<Record<ImportField, boolean>>;
}

/** IMP-11: per-column decimal-comma and day-first hints, read off the data. */
export function importColumnHints(rows: readonly MappedRow[]): ImportColumnHints {
  const hints: ImportColumnHints = { decimalComma: {}, dayFirst: {} };
  for (const f of PRICE_FIELDS) {
    hints.decimalComma[f] = detectDecimalComma(rows.map((r) => r[f] ?? ""));
  }
  for (const f of DATE_FIELDS) {
    hints.dayFirst[f] = detectDayFirst(rows.map((r) => r[f] ?? ""));
  }
  return hints;
}

export interface ImportPayloadRow {
  row: number;
  title: string | null;
  sku: string | null;
  container: string | null;
  description: string | null;
  brand: string | null;
  style: string | null;
  size: string | null;
  condition_notes: string | null;
  comps_note: string | null;
  item_category: ItemCategory | null;
  status: ItemStatus | null;
  source_name: string | null;
  sourced_by: string | null;
  acquired_price: number | null;
  acquired_date: string | null;
  listing: {
    platform: string | null;
    listing_price: number | null;
    listing_url: string | null;
    listed_at: string | null;
  } | null;
  sale: {
    sale_price: number | null;
    platform_fees: number | null;
    tax: number | null;
    shipping_cost: number | null;
    net_profit: number | null;
    payout_amount: number | null;
    tracking_number: string | null;
    sold_at: string | null;
  } | null;
}

/**
 * US-2518: the rows the durable worker consumes. The browser owns parsing and
 * mapping (that is a UI) and hands over resolved values, so the server never
 * guesses at a date format. `row` is the line in the seller's file (header = 1).
 */
export function buildImportPayload(
  rows: readonly MappedRow[],
  hints: ImportColumnHints = importColumnHints(rows),
  referenceDate: Date = new Date(),
): ImportPayloadRow[] {
  const price = (m: MappedRow, f: (typeof PRICE_FIELDS)[number]) =>
    parsePrice(m[f] ?? "", { decimalComma: hints.decimalComma[f] });
  const date = (m: MappedRow, f: (typeof DATE_FIELDS)[number]) =>
    m[f] ? parseDate(m[f]!, referenceDate, { dayFirst: hints.dayFirst[f] }) : null;
  return rows.map((m, i) => {
    const listPrice = price(m, "list_price");
    const listDate = date(m, "list_date");
    const salePrice = price(m, "sale_price");
    const saleDate = date(m, "sale_date");
    return {
      row: i + 2,
      title: m.title ?? null,
      sku: m.sku ?? null,
      container: m.container ?? null,
      description: m.description ?? null,
      brand: m.brand ?? null,
      style: m.style ?? null,
      size: m.size ?? null,
      condition_notes: m.condition_notes ?? null,
      comps_note: m.comps ?? null,
      item_category: m.item_category ? normalizeCategory(m.item_category) : null,
      status: m.status ? normalizeStatus(m.status) : null,
      source_name: m.source ?? null,
      sourced_by: m.sourced_by ?? null,
      acquired_price: price(m, "purchase_price"),
      acquired_date: date(m, "purchase_date"),
      listing:
        listPrice !== null || listDate !== null || m.link
          ? {
              // IMP-08: null lets the server infer from the URL or use 'other'.
              platform: m.marketplace ? normalizeMarketplace(m.marketplace) : null,
              listing_price: listPrice,
              listing_url: m.link ?? null,
              listed_at: listDate,
            }
          : null,
      sale:
        salePrice !== null || saleDate !== null
          ? {
              sale_price: salePrice,
              platform_fees: price(m, "fees"),
              tax: price(m, "tax"),
              shipping_cost: price(m, "shipping_cost"),
              net_profit: price(m, "net_profit"),
              payout_amount: price(m, "payout"),
              tracking_number: m.tracking ?? null,
              sold_at: saleDate,
            }
          : null,
    };
  });
}

export interface ImportValidation {
  total: number;
  /** Rows the server will accept: every row with a title. */
  willImport: number;
  // File row numbers (header = row 1) for each problem.
  noTitle: number[];
  badDate: number[];
  badPrice: number[];
  unknownStatus: number[];
  fellToOther: number[];
  duplicateSkus: number[];
  overCap: boolean;
  /** Fields two or more columns map to; only one value can win. */
  duplicateFields: ImportField[];
}

/** IMP-12: the dry run. What will import, what will be skipped, and why. */
export function validateImportRows(
  mapped: readonly MappedRow[],
  payload: readonly ImportPayloadRow[],
  mapping: readonly ImportField[],
): ImportValidation {
  const out: ImportValidation = {
    total: mapped.length,
    willImport: 0,
    noTitle: [],
    badDate: [],
    badPrice: [],
    unknownStatus: [],
    fellToOther: [],
    duplicateSkus: [],
    overCap: false,
    duplicateFields: [],
  };
  const seenSku = new Set<string>();
  for (let i = 0; i < mapped.length; i++) {
    const m = mapped[i]!;
    const p = payload[i]!;
    const rowNo = p.row;
    if (!m.title?.trim()) {
      out.noTitle.push(rowNo);
      continue;
    }
    out.willImport++;
    const dates: Array<[string | undefined, string | null]> = [
      [m.purchase_date, p.acquired_date],
      [m.list_date, p.listing?.listed_at ?? null],
      [m.sale_date, p.sale?.sold_at ?? null],
    ];
    if (dates.some(([raw, parsed]) => Boolean(raw) && parsed === null)) out.badDate.push(rowNo);
    const prices: Array<[string | undefined, number | null]> = [
      [m.purchase_price, p.acquired_price],
      [m.list_price, p.listing?.listing_price ?? null],
      [m.sale_price, p.sale?.sale_price ?? null],
    ];
    // Fees and the rest only land with a sale, so they are only read with one.
    if (p.sale) {
      prices.push(
        [m.fees, p.sale.platform_fees],
        [m.tax, p.sale.tax],
        [m.shipping_cost, p.sale.shipping_cost],
        [m.net_profit, p.sale.net_profit],
        [m.payout, p.sale.payout_amount],
      );
    }
    if (prices.some(([raw, parsed]) => Boolean(raw) && parsed === null)) {
      out.badPrice.push(rowNo);
    }
    if (m.status && p.status === null) out.unknownStatus.push(rowNo);
    if (m.item_category && p.item_category === "other" && m.item_category.trim().toLowerCase() !== "other") {
      out.fellToOther.push(rowNo);
    }
    const sku = m.sku?.trim();
    if (sku) {
      if (seenSku.has(sku)) out.duplicateSkus.push(rowNo);
      else seenSku.add(sku);
    }
  }
  out.overCap = out.willImport > MAX_IMPORT_ROWS;
  const counts = new Map<ImportField, number>();
  for (const f of mapping) {
    if (!f || f === "skip") continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  out.duplicateFields = [...counts].filter(([, n]) => n > 1).map(([f]) => f);
  return out;
}

/** The rows to send: titled rows only, and at most `limit` of them. */
export function importableRows(
  payload: readonly ImportPayloadRow[],
  limit = MAX_IMPORT_ROWS,
): ImportPayloadRow[] {
  return payload.filter((r) => r.title?.trim()).slice(0, limit);
}
