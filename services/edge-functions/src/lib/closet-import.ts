// US-9201 — the pure half of the closet import.
//
// The browser extension reads the seller's OWN Poshmark closet or Mercari
// listing list (closet-import/content.js) and posts what it saw. This module
// decides what such a batch is ALLOWED to become: which platforms, which
// fields, how many rows, which photo hosts. Nothing here touches the database
// or the network, so every rule is directly testable.
//
// The shape mirrors lib/inventory-import.ts for the CSV import, and the two
// deliberately share the run / effect / undo tables (flipdesk_import_runs,
// flipdesk_import_effects). A closet import is a CSV import whose rows came
// from a marketplace page instead of a spreadsheet, and it gets the same
// guarantees: a closed tab does not lose the run, and a bad import is one Undo
// away.

/** The marketplaces the extension can read a closet from. */
export const CLOSET_IMPORT_PLATFORMS = ["poshmark", "mercari"] as const;
export type ClosetImportPlatform = (typeof CLOSET_IMPORT_PLATFORMS)[number];

export function isClosetImportPlatform(v: unknown): v is ClosetImportPlatform {
  return typeof v === "string" &&
    (CLOSET_IMPORT_PLATFORMS as readonly string[]).includes(v);
}

/**
 * Hard cap on one batch. A Poshmark closet page renders ~48 tiles per scroll
 * and the largest closets run to a few thousand listings; 2000 bounds the
 * payload column without refusing a real closet read in one press.
 */
export const MAX_CLOSET_IMPORT_ROWS = 2000;

/** Photos copied per listing. Matches the paid extension image ceiling. */
export const MAX_CLOSET_IMPORT_PHOTOS = 8;

/**
 * Where a listing photo may be fetched FROM, per platform.
 *
 * The server copies photos into item-photos (CLAUDE.md storage rules: never
 * hot-link a marketplace image), which means it fetches a URL the extension
 * chose. safeFetch already refuses private ranges; this list additionally
 * refuses any public host that is not the marketplace's own CDN, so a batch
 * cannot make the edge download from an arbitrary site.
 */
export const CLOSET_IMPORT_PHOTO_HOSTS: Record<ClosetImportPlatform, readonly string[]> = {
  poshmark: ["cloudfront.net", "poshmark.com"],
  mercari: ["mercdn.net", "mercari.com"],
};

export function photoHostAllowed(platform: ClosetImportPlatform, url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return CLOSET_IMPORT_PHOTO_HOSTS[platform].some((h) => host === h || host.endsWith("." + h));
}

/**
 * The marketplace's own id for a listing, read off its URL.
 *
 * This is the dedupe key: a re-run matches on (platform, platform_listing_id)
 * and updates instead of duplicating. Poshmark ends every listing slug with a
 * 24-hex object id; Mercari uses `m` plus digits under /item/ (US domain also
 * serves /us/item/). Anything else is not a listing URL and the row is dropped
 * rather than imported under a made-up key.
 */
export function listingIdFromUrl(platform: ClosetImportPlatform, url: unknown): string | null {
  if (typeof url !== "string") return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (platform === "poshmark") {
    const m = path.match(/\/listing\/(?:[^/]*-)?([a-f0-9]{24})(?:\/|$)/i);
    return m ? m[1]!.toLowerCase() : null;
  }
  const m = path.match(/\/(?:us\/)?item\/(m\d{6,})(?:\/|$)/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** One listing as the extension posts it. Every field is optional on the wire. */
export interface ClosetListingInput {
  listingUrl?: unknown;
  platformListingId?: unknown;
  title?: unknown;
  description?: unknown;
  priceCents?: unknown;
  size?: unknown;
  brand?: unknown;
  condition?: unknown;
  photoUrls?: unknown;
  /** True when the row came from the listing's own page rather than a tile. */
  detail?: unknown;
}

/** One listing as the run payload stores it. */
export interface ClosetImportRow {
  /** 1-based position in the batch, for the seller's error list. */
  row: number;
  platform: ClosetImportPlatform;
  platform_listing_id: string;
  listing_url: string;
  title: string;
  description: string | null;
  /** Major units, the unit listings.listing_price uses. */
  price: number | null;
  size: string | null;
  brand: string | null;
  /** The seller's own condition wording on the marketplace, verbatim. */
  condition: string | null;
  photo_urls: string[];
  detail: boolean;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function priceMajor(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v) / 100;
}

/**
 * Coerce one batch into rows the worker may write.
 *
 * Everything is rebuilt field by field and nothing is spread through, so a key
 * the extension never meant to send cannot reach the payload column. Rows
 * without a recognisable listing id or a title are dropped: the first has no
 * dedupe key, the second would create an item nobody can find.
 */
export function normalizeClosetRows(
  platform: ClosetImportPlatform,
  input: unknown,
): ClosetImportRow[] {
  if (!Array.isArray(input)) return [];
  const out: ClosetImportRow[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, MAX_CLOSET_IMPORT_ROWS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as ClosetListingInput;
    const listingUrl = str(r.listingUrl, 500);
    if (!listingUrl) continue;
    const id = listingIdFromUrl(platform, listingUrl) ??
      (str(r.platformListingId, 64)?.toLowerCase() ?? null);
    if (!id) continue;
    const title = str(r.title, 200);
    if (!title) continue;
    // The same listing read twice in one batch (a tile and its own page, say)
    // keeps the fuller row, which is whichever came with a detail flag.
    const detail = r.detail === true;
    if (seen.has(id) && !detail) continue;

    const photos: string[] = [];
    if (Array.isArray(r.photoUrls)) {
      for (const p of r.photoUrls) {
        const u = str(p, 1000);
        if (!u || !photoHostAllowed(platform, u) || photos.includes(u)) continue;
        photos.push(u);
        if (photos.length >= MAX_CLOSET_IMPORT_PHOTOS) break;
      }
    }

    const row: ClosetImportRow = {
      row: out.length + 1,
      platform,
      platform_listing_id: id,
      listing_url: listingUrl,
      title,
      description: str(r.description, 8000),
      price: priceMajor(r.priceCents),
      size: str(r.size, 40),
      brand: str(r.brand, 80),
      condition: str(r.condition, 80),
      photo_urls: photos,
      detail,
    };
    if (seen.has(id)) {
      const at = out.findIndex((x) => x.platform_listing_id === id);
      if (at !== -1) out[at] = { ...row, row: out[at]!.row };
      continue;
    }
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * The item columns a re-run may FILL on a listing it has seen before.
 *
 * Fill, never overwrite: the seller may have edited the item in FlipDesk since
 * the first import, and a second read of the same closet must not undo that
 * (the US-1082 rule the CSV import follows). `condition_notes` is included
 * here and NOT in the CSV list because for a closet row it carries the
 * marketplace's own condition wording, which is marketplace-owned and blank
 * until the marketplace says otherwise.
 */
export const CLOSET_FILL_ITEM_FIELDS = [
  "description",
  "brand",
  "size",
  "condition_notes",
] as const;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Columns a closet row would write on a fresh inventory item. */
export function itemFieldsForRow(row: ClosetImportRow): Record<string, unknown> {
  return {
    description: row.description,
    brand: row.brand,
    size: row.size,
    condition_notes: row.condition ? `Listed on ${platformLabel(row.platform)} as: ${row.condition}` : null,
  };
}

/** Blank item columns this row can fill, with nothing else. */
export function closetFillPatch(
  existing: Record<string, unknown>,
  row: ClosetImportRow,
): Record<string, unknown> {
  const incoming = itemFieldsForRow(row);
  const patch: Record<string, unknown> = {};
  for (const field of CLOSET_FILL_ITEM_FIELDS) {
    if (isBlank(existing[field]) && !isBlank(incoming[field])) patch[field] = incoming[field];
  }
  return patch;
}

/** Listing columns a re-run refreshes from the marketplace. */
export const CLOSET_LISTING_FIELDS = [
  "listing_price",
  "listing_url",
  "listing_title",
  "listing_description",
] as const;

/**
 * What changes on an existing listing row, and what it held before.
 *
 * Price and URL follow the marketplace, because that is where the seller
 * changes them for an extension channel. Title and description are filled only
 * when blank: a title the seller rewrote in FlipDesk is theirs.
 */
export function closetListingPatch(
  existing: Record<string, unknown>,
  row: ClosetImportRow,
): { patch: Record<string, unknown>; previous: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  if (row.price !== null && existing.listing_price !== row.price) {
    patch.listing_price = row.price;
    previous.listing_price = existing.listing_price ?? null;
  }
  if (existing.listing_url !== row.listing_url) {
    patch.listing_url = row.listing_url;
    previous.listing_url = existing.listing_url ?? null;
  }
  if (isBlank(existing.listing_title)) {
    patch.listing_title = row.title;
    previous.listing_title = existing.listing_title ?? null;
  }
  if (isBlank(existing.listing_description) && row.description) {
    patch.listing_description = row.description;
    previous.listing_description = existing.listing_description ?? null;
  }
  return { patch, previous };
}

export function platformLabel(platform: ClosetImportPlatform): string {
  return platform === "poshmark" ? "Poshmark" : "Mercari";
}

/** item_photos.photo_type for the n-th copied photo: cover first, then details. */
export function photoTypeForIndex(i: number): "front" | "detail" {
  return i === 0 ? "front" : "detail";
}

/**
 * The provenance marker written to listings.platform_fields.closet_import.
 *
 * listing_origin stays 'gradethread' (the enum has no third value, and a
 * switcher wants the row fully editable here), so this is where the row says
 * which marketplace it came from and which run brought it.
 */
export function closetImportProvenance(
  row: ClosetImportRow,
  runId: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    platform: row.platform,
    listing_url: row.listing_url,
    run_id: runId,
    imported_at: nowIso,
    from_detail_page: row.detail,
  };
}
