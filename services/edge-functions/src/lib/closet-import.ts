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
export const CLOSET_IMPORT_PLATFORMS = ["poshmark", "mercari", "grailed"] as const;
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
 * US-3263. What an account WITHOUT a seller plan may bring in.
 *
 * Closet import used to refuse those accounts outright: 402, no rows, and on
 * the web no card at all. The person that refusal met was almost always
 * someone deciding whether to pay, and what would have decided it is seeing
 * their own listings appear. A lapsed seller met the same wall, with no
 * sentence explaining where the importer went.
 *
 * 25 is a real closet page rather than a token: Poshmark renders ~48 tiles per
 * scroll, so a single unscrolled page fits inside it, and 25 items is enough
 * inventory for the pipeline, money and listing views to say something true.
 * It is small enough that nobody runs a business on it.
 */
export const FREE_CLOSET_IMPORT_ROWS = 25;

/**
 * How many NEW listings an unentitled read may bring in, given how much of the
 * account's own active-listing cap is still free.
 *
 * MIN-OF-CAPS, the shape plan-gate's aiCapFor already uses for the trial: each
 * input can only lower the answer, so a third one added later cannot
 * accidentally raise it.
 *
 * The 25-row read bound on its own is not the whole rule, and treating it as
 * the whole rule was a hole. Free carries an activeListingCap of its own, and
 * a bound that applies PER READ is no bound at all against a seller who
 * presses Import again: twenty presses is five hundred live listings on a plan
 * that allows twenty-five. Composing the two means the first read of an empty
 * catalog still brings the full 25 (the switcher this story exists for), and
 * the twenty-first read brings nothing, because by then the plan itself is
 * full and that is the honest answer.
 *
 * `null` headroom means unlimited or unknown: an uncapped plan, a super_admin,
 * or a users row that would not read. Unknown falls back to the flat row bound
 * rather than to zero: a database hiccup must not turn into the locked door
 * this story removed.
 */
export function freeRowAllowance(activeListingHeadroom: number | null): number {
  if (activeListingHeadroom === null) return FREE_CLOSET_IMPORT_ROWS;
  return Math.max(0, Math.min(FREE_CLOSET_IMPORT_ROWS, activeListingHeadroom));
}

/**
 * Trim a batch to what this account is allowed to import, and say what was
 * left behind.
 *
 * Pure, and separated from the route, because the refusal it replaces was the
 * kind of rule that is easy to get subtly wrong in an if-statement: an
 * entitled account must be affected in NO way, and an unentitled one must be
 * bounded by the server rather than by the browser that asked.
 *
 * `allowance` defaults to the flat row bound. `isKnown` marks rows this tenant
 * ALREADY holds a listing for; those are kept whatever the allowance, because
 * they consume no new slot, which is the rule the paid capacity gate applies when
 * it counts only new rows against the plan. Without it a seller who imported
 * 25 free listings could never re-read their own closet to refresh them.
 */
export function applyFreeTierCap<T>(
  rows: readonly T[],
  sellerEnabled: boolean,
  opts?: { allowance?: number; isKnown?: (row: T) => boolean },
): { rows: T[]; leftBehind: number; capped: boolean; allowance: number | null } {
  if (sellerEnabled) {
    return { rows: [...rows], leftBehind: 0, capped: false, allowance: null };
  }
  const allowance = Math.max(0, opts?.allowance ?? FREE_CLOSET_IMPORT_ROWS);
  const isKnown = opts?.isKnown;
  const kept: T[] = [];
  let taken = 0;
  for (const row of rows) {
    if (isKnown?.(row)) {
      kept.push(row);
      continue;
    }
    if (taken < allowance) {
      kept.push(row);
      taken++;
    }
  }
  return {
    rows: kept,
    leftBehind: rows.length - kept.length,
    capped: kept.length < rows.length,
    allowance,
  };
}

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
  // US-3155: Grailed serves every listing render from media-assets.grailed.com.
  // The bare apex is listed too so a future host under it still resolves, and
  // nothing else on grailed.com serves photos.
  grailed: ["grailed.com"],
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
  if (platform === "grailed") {
    // US-3155: /listings/100703624-ann-demeulemeester-jean-boots. The numeric
    // id LEADS the slug, unlike Poshmark's, where it trails it. Read off a live
    // listing 2026-09-08.
    const m = path.match(/\/listings\/(\d{5,})(?:-|\/|$)/i);
    return m ? m[1]! : null;
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
  const labels: Record<ClosetImportPlatform, string> = {
    poshmark: "Poshmark",
    mercari: "Mercari",
    grailed: "Grailed",
  };
  return labels[platform];
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
