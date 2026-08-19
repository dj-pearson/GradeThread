// US-9109: the public read surface for listings and sales.
//
// Reads items_full, the same view lib/api-items.ts uses. That is deliberate:
// the view already joins each item to its most recent listing and sale, so
// "what is live" and "what sold" are one scoped query each rather than a manual
// three-table join whose tenant filter has to be remembered in three places.
//
// The consequence, stated plainly: these are ITEM-CENTRIC views. An item with
// several historical listings appears once, showing the most recent. That is
// what a seller means by "what is live", and it is what the dashboard shows.
// A full listing history would need the listings table directly and is not what
// any of these tools are for.
//
// TENANCY (US-268): every query scopes on `.eq("user_id", tenantId)`.
// MONEY: integer cents, never a float and never a formatted string.

import { supabaseAdmin } from "./supabase.ts";

// deno-lint-ignore no-explicit-any
export type ListingsDb = any;

export const LISTINGS_PAGE_DEFAULT = 25;
export const LISTINGS_PAGE_MAX = 100;

export interface ListingSummary {
  listing_id: string | null;
  item_id: string;
  title: string;
  brand: string | null;
  size: string | null;
  marketplace: string | null;
  status: string | null;
  price_cents: number | null;
  url: string | null;
  listed_at: string | null;
  /** Whole days since it went live. Null when it has no list date. */
  days_live: number | null;
  watchers: number | null;
  views: number | null;
  grade: number | null;
}

export interface SaleSummary {
  item_id: string;
  title: string;
  brand: string | null;
  marketplace: string | null;
  status: string | null;
  sale_price_cents: number | null;
  fees_cents: number | null;
  tax_cents: number | null;
  shipping_cost_cents: number | null;
  net_profit_cents: number | null;
  purchase_price_cents: number | null;
  sold_at: string | null;
  days_to_sell: number | null;
}

export interface ListingsPage {
  items: ListingSummary[];
  next_cursor: string | null;
  total: number;
}

export interface SalesPage {
  items: SaleSummary[];
  next_cursor: string | null;
  total: number;
  /** Roll-up over the WHOLE match, not just this page. */
  totals: {
    gross_cents: number;
    net_profit_cents: number;
    count: number;
    /** True when the roll-up covers only the returned page. */
    page_only: boolean;
  };
}

export interface ListListingsFilters {
  marketplace?: string;
  status?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  /** Only listings live at least this many days. */
  minDaysLive?: number;
  minWatchers?: number;
  limit?: number;
  cursor?: string;
}

export interface ListSalesFilters {
  soldAfter?: string;
  soldBefore?: string;
  marketplace?: string;
  /** Defaults to completed sales only; the other statuses are not revenue. */
  status?: string;
  limit?: number;
  cursor?: string;
}

export class ListingQueryError extends Error {}

const LISTING_COLUMNS =
  "id, item_title, brand, size, listing_id, listing_platform, listing_status, list_price, link, " +
  "list_date, listing_watchers, listing_views, grade_value, created_at";

const SALE_COLUMNS =
  "id, item_title, brand, listing_platform, sale_status, sale_price, fees, tax, shipping_cost, " +
  "net_profit, purchase_price, sale_date, days_to_sell, created_at";

function toCents(value: unknown): number | null {
  if (value == null) return null;
  const asNumber = typeof value === "string" ? Number(value) : value;
  if (typeof asNumber !== "number" || !Number.isFinite(asNumber)) return null;
  return Math.round(asNumber * 100);
}

export function clampListingsLimit(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return LISTINGS_PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(requested), 1), LISTINGS_PAGE_MAX);
}

export function encodeListingCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`);
}

export function decodeListingCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = atob(cursor).split("|");
    if (!createdAt || !id) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Whole days between a list date and now. Null rather than 0 when unknown. */
function daysLive(listDate: unknown, now: number): number | null {
  if (typeof listDate !== "string" || !listDate) return null;
  const listed = Date.parse(listDate);
  if (Number.isNaN(listed)) return null;
  return Math.max(0, Math.floor((now - listed) / 86_400_000));
}

export async function listListings(
  tenantId: string,
  filters: ListListingsFilters = {},
  db: ListingsDb = supabaseAdmin,
  now: number = Date.now(),
): Promise<ListingsPage> {
  const limit = clampListingsLimit(filters.limit);

  let query = db
    .from("items_full")
    .select(LISTING_COLUMNS, { count: "exact" })
    .eq("user_id", tenantId)
    // Only rows that actually have a listing. Without this the "listings" list
    // is really the inventory list with mostly-null columns.
    .not("listing_id", "is", null);

  if (filters.marketplace) query = query.eq("listing_platform", filters.marketplace);
  if (filters.status) query = query.eq("listing_status", filters.status);
  if (filters.minPriceCents != null) query = query.gte("list_price", filters.minPriceCents / 100);
  if (filters.maxPriceCents != null) query = query.lte("list_price", filters.maxPriceCents / 100);
  if (filters.minWatchers != null) query = query.gte("listing_watchers", filters.minWatchers);
  if (filters.minDaysLive != null) {
    // "Live at least N days" means listed on or before now - N days.
    const cutoff = new Date(now - filters.minDaysLive * 86_400_000).toISOString();
    query = query.lte("list_date", cutoff);
  }

  if (filters.cursor) {
    const parts = decodeListingCursor(filters.cursor);
    if (!parts) throw new ListingQueryError("cursor is not a valid pagination cursor");
    query = query.lt("created_at", parts.createdAt);
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      listing_id: (row.listing_id as string | null) ?? null,
      item_id: String(row.id),
      title: (row.item_title as string | null) ?? "",
      brand: (row.brand as string | null) ?? null,
      size: (row.size as string | null) ?? null,
      marketplace: (row.listing_platform as string | null) ?? null,
      status: (row.listing_status as string | null) ?? null,
      price_cents: toCents(row.list_price),
      url: (row.link as string | null) ?? null,
      listed_at: (row.list_date as string | null) ?? null,
      days_live: daysLive(row.list_date, now),
      watchers: (row.listing_watchers as number | null) ?? null,
      views: (row.listing_views as number | null) ?? null,
      grade: (row.grade_value as number | null) ?? null,
    })),
    next_cursor: hasMore && last
      ? encodeListingCursor(String(last.created_at), String(last.id))
      : null,
    total: count ?? page.length,
  };
}

export async function listSales(
  tenantId: string,
  filters: ListSalesFilters = {},
  db: ListingsDb = supabaseAdmin,
): Promise<SalesPage> {
  const limit = clampListingsLimit(filters.limit);

  let query = db
    .from("items_full")
    .select(SALE_COLUMNS, { count: "exact" })
    .eq("user_id", tenantId)
    .not("sale_status", "is", null);

  // Only completed sales count as revenue. A cancelled or refunded row in a
  // revenue total is the difference between a real number and a flattering one,
  // so the default is explicit rather than "all statuses".
  query = query.eq("sale_status", filters.status ?? "completed");

  if (filters.marketplace) query = query.eq("listing_platform", filters.marketplace);
  if (filters.soldAfter) query = query.gte("sale_date", filters.soldAfter);
  if (filters.soldBefore) query = query.lte("sale_date", filters.soldBefore);

  if (filters.cursor) {
    const parts = decodeListingCursor(filters.cursor);
    if (!parts) throw new ListingQueryError("cursor is not a valid pagination cursor");
    query = query.lt("created_at", parts.createdAt);
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const items: SaleSummary[] = page.map((row) => ({
    item_id: String(row.id),
    title: (row.item_title as string | null) ?? "",
    brand: (row.brand as string | null) ?? null,
    marketplace: (row.listing_platform as string | null) ?? null,
    status: (row.sale_status as string | null) ?? null,
    sale_price_cents: toCents(row.sale_price),
    fees_cents: toCents(row.fees),
    tax_cents: toCents(row.tax),
    shipping_cost_cents: toCents(row.shipping_cost),
    net_profit_cents: toCents(row.net_profit),
    purchase_price_cents: toCents(row.purchase_price),
    sold_at: (row.sale_date as string | null) ?? null,
    days_to_sell: (row.days_to_sell as number | null) ?? null,
  }));

  const total = count ?? items.length;
  return {
    items,
    next_cursor: hasMore && last
      ? encodeListingCursor(String(last.created_at), String(last.id))
      : null,
    total,
    totals: {
      gross_cents: items.reduce((sum, s) => sum + (s.sale_price_cents ?? 0), 0),
      net_profit_cents: items.reduce((sum, s) => sum + (s.net_profit_cents ?? 0), 0),
      count: items.length,
      // Said out loud rather than implied: the roll-up covers the rows on this
      // page. A model that reports a page total as the period total tells the
      // seller their revenue is smaller than it is.
      page_only: total > items.length,
    },
  };
}
