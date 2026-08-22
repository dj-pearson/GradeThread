// US-2518 — the pure half of the durable CSV inventory import.
//
// The browser parses the file and resolves the column mapping (it has to: the
// mapping is a UI). It then posts one normalized row per file row, and this
// module decides what an import is ALLOWED to write. Nothing here touches the
// database, so it is all directly testable.

/** Hard cap on one import, so a pasted 200k-row sheet cannot become a payload. */
export const MAX_IMPORT_ROWS = 5000;

/** A run started this many times fails terminally rather than looping. */
export const MAX_RUN_ATTEMPTS = 5;

/**
 * A run untouched for this long was left by a dead worker. Comfortably above the
 * per-row work, so a live run never looks stale (durable-jobs contract).
 */
export const RUN_STALE_MS = 6 * 60 * 1000;

/**
 * inventory_items columns a re-import may FILL on a row matched by SKU.
 *
 * Deliberately excludes the GradeThread-owned fields — `sku` (the match key),
 * `source_id`, `condition_notes`, `acquired_price`, `acquired_date` — which no
 * CSV may write over (vault/20-domain/sync-source-of-truth.md).
 *
 * THIS IS THE ONLY COPY, and that is the point. The line here used to claim
 * this list mirrored one in the browser import page. US-2518 made that false
 * and nobody updated it: that story DELETED the browser-side list and moved the
 * rule to where the writing happens, precisely so there is one source of truth
 * for which columns a CSV may touch. The import page says so in a comment of
 * its own. A reader following the old line found a real file with no such
 * symbol in it, and would reasonably have recreated the duplicate US-2518
 * removed on purpose (US-2800).
 */
export const FILL_ITEM_FIELDS = [
  "title",
  "container",
  "description",
  "brand",
  "style",
  "size",
  "item_category",
  "sourced_by",
  "status",
] as const;

export type FillItemField = (typeof FILL_ITEM_FIELDS)[number];

export const ITEM_STATUS_VALUES = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "graded",
  "comped",
  "drafted",
  "listed",
  "sold",
  "shipped",
  "completed",
  "returned",
  "archived",
  "keeping",
  "wearing",
] as const;

export const ITEM_CATEGORY_VALUES = [
  "clothing",
  "shoes",
  "watches",
  "sports_cards",
  "collectibles",
  "electronics",
  "books",
  // US-2797: jewelry/bags/accessories arrived with migration 00230 and
  // headwear with 00570; this list learned none of them. A value absent here
  // is not rejected loudly, it is dropped or refused while the database would
  // have taken it.
  "jewelry",
  "bags",
  "accessories",
  "headwear",
  "other",
] as const;

export interface ImportListingInput {
  listing_price?: number | null;
  listing_url?: string | null;
  listed_at?: string | null;
}

export interface ImportSaleInput {
  sale_price?: number | null;
  platform_fees?: number | null;
  tax?: number | null;
  shipping_cost?: number | null;
  net_profit?: number | null;
  payout_amount?: number | null;
  tracking_number?: string | null;
  sold_at?: string | null;
}

export interface ImportRowInput {
  /** 1-based row number in the seller's file, used in the error list. */
  row?: number;
  title?: string | null;
  sku?: string | null;
  container?: string | null;
  description?: string | null;
  brand?: string | null;
  style?: string | null;
  size?: string | null;
  condition_notes?: string | null;
  comps_note?: string | null;
  item_category?: string | null;
  status?: string | null;
  source_name?: string | null;
  sourced_by?: string | null;
  acquired_price?: number | null;
  acquired_date?: string | null;
  listing?: ImportListingInput | null;
  sale?: ImportSaleInput | null;
}

function str(v: unknown, max = 2000): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function num(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

/** yyyy-mm-dd only. Anything else is dropped rather than guessed at. */
function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(t) ? (t as T) : null;
}

function listing(v: unknown): ImportListingInput | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Record<string, unknown>;
  const out: ImportListingInput = {
    listing_price: num(raw.listing_price),
    listing_url: str(raw.listing_url, 2000),
    listed_at: isoDate(raw.listed_at),
  };
  // Nothing worth a listing row.
  if (
    out.listing_price === null && out.listing_url === null &&
    out.listed_at === null
  ) {
    return null;
  }
  return out;
}

function sale(v: unknown): ImportSaleInput | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Record<string, unknown>;
  const out: ImportSaleInput = {
    sale_price: num(raw.sale_price),
    platform_fees: num(raw.platform_fees),
    tax: num(raw.tax),
    shipping_cost: num(raw.shipping_cost),
    net_profit: num(raw.net_profit),
    payout_amount: num(raw.payout_amount),
    tracking_number: str(raw.tracking_number, 200),
    sold_at: isoDate(raw.sold_at),
  };
  if (out.sale_price === null && out.sold_at === null) return null;
  return out;
}

/**
 * Reduces whatever the browser posted to the fields an import may write.
 * Rows with no title are dropped — the client blocks that too, but this is the
 * side that has to hold. Never reads a user_id: the caller sets it from the
 * token (US-268).
 */
export function normalizeImportRows(input: unknown[]): ImportRowInput[] {
  const out: ImportRowInput[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = str(r.title, 500);
    if (!title) continue;
    out.push({
      row: num(r.row) ?? i + 2,
      title,
      sku: str(r.sku, 200),
      container: str(r.container, 200),
      description: str(r.description, 20000),
      brand: str(r.brand, 200),
      style: str(r.style, 200),
      size: str(r.size, 100),
      condition_notes: str(r.condition_notes, 5000),
      comps_note: str(r.comps_note, 5000),
      item_category: oneOf(r.item_category, ITEM_CATEGORY_VALUES),
      status: oneOf(r.status, ITEM_STATUS_VALUES),
      source_name: str(r.source_name, 200),
      sourced_by: str(r.sourced_by, 200),
      acquired_price: num(r.acquired_price),
      acquired_date: isoDate(r.acquired_date),
      listing: listing(r.listing),
      sale: sale(r.sale),
    });
  }
  return out;
}

/** null / undefined / whitespace-only counts as blank (US-1076 semantics). */
export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

/**
 * The fill-only patch for an existing item (US-1082): each fillable column is
 * written ONLY where the stored value is blank and the incoming one is not. A
 * populated value is never overwritten, which is why a re-import cannot damage
 * a catalog.
 */
export function fillPatch(
  existing: Record<string, unknown>,
  row: ImportRowInput,
): Record<string, unknown> {
  const incoming: Record<string, unknown> = {
    title: row.title ?? null,
    container: row.container ?? null,
    description: row.description ?? null,
    brand: row.brand ?? null,
    style: row.style ?? null,
    size: row.size ?? null,
    item_category: row.item_category ?? null,
    sourced_by: row.sourced_by ?? null,
    status: row.status ?? null,
  };
  const patch: Record<string, unknown> = {};
  for (const field of FILL_ITEM_FIELDS) {
    const value = incoming[field];
    if (isBlank(existing[field]) && !isBlank(value)) patch[field] = value;
  }
  return patch;
}
