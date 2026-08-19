// US-9107: the public read surface for inventory.
//
// ONE definition, used by both GET /api/v1/items (partners) and the
// gradethread_list_items / gradethread_get_item MCP tools (the connector). The
// connector must not read the tables directly: a second query path is a second
// place for a tenant scope to be forgotten, and it drifts from what partners
// see the moment either side changes.
//
// TENANCY (US-268). The edge runs the service-role client and BYPASSES RLS, so
// every query here scopes on `.eq("user_id", tenantId)` and every by-id read
// checks ownership BEFORE returning anything. An id from a request body is
// never trusted.
//
// TOKEN FRUGALITY. The list projection is deliberately small. A connector that
// dumps 200 full item records into a chat window has spent the context the
// conversation needed; the caller asks for one item when it wants the detail.

import { supabaseAdmin } from "./supabase.ts";
import { itemPhotoAiUrls } from "./item-photo-storage.ts";

/**
 * The database handle, injectable purely so the tenant scope is testable
 * without a running stack. Production passes nothing and gets supabaseAdmin.
 *
 * This is not decoration: "did every query filter on user_id" is the single
 * property US-268 rests on, and the integration lane that could otherwise prove
 * it needs a full stack and stays out of `npm run verify`. Injecting the client
 * moves that assertion into the pre-push suite.
 */
// deno-lint-ignore no-explicit-any
export type ItemsDb = any;

export const ITEMS_PAGE_DEFAULT = 25;
export const ITEMS_PAGE_MAX = 100;

/** The compact row a list returns. Keep this small on purpose. */
export interface ItemSummary {
  id: string;
  item_number: string | null;
  title: string;
  brand: string | null;
  size: string | null;
  category: string | null;
  status: string;
  /** Integer cents, never a float and never a formatted string. */
  list_price_cents: number | null;
  grade: number | null;
  grade_label: string | null;
  listed: boolean;
  photo_count: number;
  created_at: string;
}

export interface ItemPhoto {
  id: string;
  photo_type: string | null;
  /** Signed for the private bucket, public for item-photos. Never a raw path. */
  url: string;
  sort_order: number | null;
}

export interface ItemDetail extends ItemSummary {
  description: string | null;
  color: string | null;
  style: string | null;
  notes: string | null;
  container: string | null;
  location_bin: string | null;
  purchase_price_cents: number | null;
  purchase_date: string | null;
  source_name: string | null;
  target_price_cents: number | null;
  measurements: Record<string, number | string> | null;
  certificate_url: string | null;
  has_required_photos: boolean;
  listing: {
    id: string | null;
    platform: string | null;
    status: string | null;
    url: string | null;
    price_cents: number | null;
    listed_at: string | null;
    watchers: number | null;
    views: number | null;
  } | null;
  sale: {
    status: string | null;
    price_cents: number | null;
    sold_at: string | null;
    net_profit_cents: number | null;
  } | null;
  photos: ItemPhoto[];
  updated_at: string;
}

export interface ListItemsFilters {
  status?: string;
  brand?: string;
  category?: string;
  /** Matches the title. Wildcards in the input are escaped, not honoured. */
  search?: string;
  listed?: boolean;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  cursor?: string;
}

export interface ListItemsPage {
  items: ItemSummary[];
  /** Opaque; pass it back as `cursor` for the next page. Null at the end. */
  next_cursor: string | null;
  /** Total matching rows, so a caller knows whether it saw everything. */
  total: number;
}

// The exact columns the summary needs. Selecting "*" from items_full would pull
// comps, ai_field_sources and every measurement on every row.
const SUMMARY_COLUMNS =
  "id, item_number, item_title, brand, size, category, status, list_price, grade_value, grade_label, listed, photo_count, created_at";

const DETAIL_COLUMNS = SUMMARY_COLUMNS +
  ", item_description, color, style, notes, container, location_bin, purchase_price, purchase_date, source_name, target_price, measurements, certificate_url, has_required_photos, listing_id, listing_platform, listing_status, link, list_date, listing_watchers, listing_views, sale_status, sale_price, sale_date, net_profit, updated_at, user_id";

/**
 * Money crosses this boundary as integer cents.
 *
 * The columns are Postgres `decimal`, which supabase-js hands back as a number
 * or a string depending on the driver path. Handing a model "$24.99" or a float
 * gets arithmetic back that cannot be audited; cents plus a currency code can be
 * checked.
 */
function toCents(value: unknown): number | null {
  if (value == null) return null;
  const asNumber = typeof value === "string" ? Number(value) : value;
  if (typeof asNumber !== "number" || !Number.isFinite(asNumber)) return null;
  return Math.round(asNumber * 100);
}

/**
 * Escape the LIKE metacharacters so a caller searching for "50% off" gets rows
 * containing that text rather than a wildcard match on everything.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface CursorParts {
  createdAt: string;
  id: string;
}

export function encodeCursor(parts: CursorParts): string {
  return btoa(`${parts.createdAt}|${parts.id}`);
}

export function decodeCursor(cursor: string): CursorParts | null {
  try {
    const [createdAt, id] = atob(cursor).split("|");
    if (!createdAt || !id) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function clampLimit(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return ITEMS_PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(requested), 1), ITEMS_PAGE_MAX);
}

type ItemsFullRow = Record<string, unknown>;

function toSummary(row: ItemsFullRow): ItemSummary {
  return {
    id: String(row.id),
    item_number: (row.item_number as string | null) ?? null,
    title: (row.item_title as string | null) ?? "",
    brand: (row.brand as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    status: String(row.status ?? ""),
    list_price_cents: toCents(row.list_price),
    grade: (row.grade_value as number | null) ?? null,
    grade_label: (row.grade_label as string | null) ?? null,
    listed: row.listed === true,
    photo_count: typeof row.photo_count === "number" ? row.photo_count : 0,
    created_at: String(row.created_at ?? ""),
  };
}

/** Bad cursor / bad filter, told apart from an empty result. */
export class ItemQueryError extends Error {}

export async function listItems(
  tenantId: string,
  filters: ListItemsFilters = {},
  db: ItemsDb = supabaseAdmin,
): Promise<ListItemsPage> {
  const limit = clampLimit(filters.limit);

  let query = db
    .from("items_full")
    .select(SUMMARY_COLUMNS, { count: "exact" })
    // US-268: the tenant scope. Never optional, never derived from input.
    .eq("user_id", tenantId);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.brand) query = query.ilike("brand", escapeLike(filters.brand));
  if (filters.category) query = query.ilike("category", escapeLike(filters.category));
  if (filters.search) query = query.ilike("item_title", `%${escapeLike(filters.search)}%`);
  if (filters.listed !== undefined) query = query.eq("listed", filters.listed);
  if (filters.createdAfter) query = query.gte("created_at", filters.createdAfter);
  if (filters.createdBefore) query = query.lte("created_at", filters.createdBefore);

  // Keyset pagination on (created_at, id). Offset pagination drifts when rows
  // are inserted mid-walk, which for a connector paging an active inventory
  // means silently skipped items.
  if (filters.cursor) {
    const parts = decodeCursor(filters.cursor);
    if (!parts) throw new ItemQueryError("cursor is not a valid pagination cursor");
    query = query.lt("created_at", parts.createdAt);
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ItemsFullRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(toSummary),
    next_cursor: hasMore && last
      ? encodeCursor({ createdAt: String(last.created_at), id: String(last.id) })
      : null,
    total: count ?? page.length,
  };
}

/**
 * One item, or null when it does not exist OR is not this tenant's. The two are
 * deliberately indistinguishable: telling a caller "that id exists but is not
 * yours" is an existence oracle over every other tenant's inventory.
 */
export async function getItem(
  tenantId: string,
  itemId: string,
  db: ItemsDb = supabaseAdmin,
): Promise<ItemDetail | null> {
  const { data, error } = await db
    .from("items_full")
    .select(DETAIL_COLUMNS)
    .eq("id", itemId)
    // The ownership check is part of the SAME query, so there is no window in
    // which a row is fetched before it is authorized.
    .eq("user_id", tenantId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  // Cast through unknown: supabase-js types a maybeSingle() select on a VIEW as
  // a union that includes its error shape (the same resolution quirk noted in
  // CLAUDE.md for submission_images).
  const row = data as unknown as ItemsFullRow;
  const photos = await loadPhotos(itemId, db);

  return {
    ...toSummary(row),
    description: (row.item_description as string | null) ?? null,
    color: (row.color as string | null) ?? null,
    style: (row.style as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    container: (row.container as string | null) ?? null,
    location_bin: (row.location_bin as string | null) ?? null,
    purchase_price_cents: toCents(row.purchase_price),
    purchase_date: (row.purchase_date as string | null) ?? null,
    source_name: (row.source_name as string | null) ?? null,
    target_price_cents: toCents(row.target_price),
    measurements: (row.measurements as Record<string, number | string> | null) ?? null,
    certificate_url: (row.certificate_url as string | null) ?? null,
    has_required_photos: row.has_required_photos === true,
    listing: row.listing_id
      ? {
        id: String(row.listing_id),
        platform: (row.listing_platform as string | null) ?? null,
        status: (row.listing_status as string | null) ?? null,
        url: (row.link as string | null) ?? null,
        price_cents: toCents(row.list_price),
        listed_at: (row.list_date as string | null) ?? null,
        watchers: (row.listing_watchers as number | null) ?? null,
        views: (row.listing_views as number | null) ?? null,
      }
      : null,
    sale: row.sale_status
      ? {
        status: String(row.sale_status),
        price_cents: toCents(row.sale_price),
        sold_at: (row.sale_date as string | null) ?? null,
        net_profit_cents: toCents(row.net_profit),
      }
      : null,
    photos,
    updated_at: String(row.updated_at ?? ""),
  };
}

/**
 * Photo URLs come from itemPhotoAiUrls, which picks the bucket per photo type
 * and SIGNS the private ones. Never call getPublicUrl here: grading `label`
 * shots and anything else in submission-images must not become a permanent
 * public link, and a source-guard test enforces that rule repo-wide.
 *
 * Ownership is already established by the caller's getItem query, and the rows
 * are additionally constrained to that item id.
 */
async function loadPhotos(itemId: string, db: ItemsDb = supabaseAdmin): Promise<ItemPhoto[]> {
  const { data, error } = await db
    .from("item_photos")
    // photo_role is selected because filterListablePhotos-adjacent helpers read
    // it; an absent field reads as NULL and a NULL role on a measurement row
    // means something specific (US-2462).
    .select("id, photo_type, photo_role, storage_path, photo_url, sort_order")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<
    {
      id: string;
      photo_type: string | null;
      photo_role: string | null;
      storage_path: string | null;
      photo_url: string | null;
      sort_order: number | null;
    }
  >;

  // itemPhotoAiUrls DROPS rows whose URL cannot be resolved. That is the right
  // behaviour here: a photo the caller cannot fetch is not a photo, and
  // returning a null URL invites a client to build one from the storage path.
  const withUrls = await itemPhotoAiUrls(rows);

  return withUrls.map(({ row, url }) => ({
    id: row.id,
    photo_type: row.photo_type ?? null,
    url,
    sort_order: row.sort_order ?? null,
  }));
}
