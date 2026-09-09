// US-3196: mirroring an eBay listing's pictures onto a FlipDesk item BY
// REFERENCE. Pure module (no supabase, no fetch) so it unit-tests without env.
//
// The eBay pull sync already mirrors title, price, category and item specifics.
// It never mirrored the pictures, so a seller who synced their active listings
// got a catalog of rows with no imagery. Copying the bytes would have fixed that
// and charged storage for every image the seller will never open.
//
// So these rows hot-link: photo_url is eBay's own CDN URL, storage_path stays
// NULL and remote_source says the NULL is deliberate. That is the OPPOSITE of
// the closet import (lib/closet-import-run.ts), which downloads Poshmark and
// Mercari photos into our bucket. The two differ on purpose and the reason is
// the connection: an eBay sync is an authenticated, continuous link to listings
// that stay live, so the picture keeps working and the seller can adopt it the
// moment they want to edit or relist. A closet import is a one-shot scrape with
// no such link, and its photos would rot with nothing watching.
//
// What a reference row cannot do: be cropped or tone matched (there is no file
// to write back), be sent to eBay on a publish (see the storage_path filter on
// the outbound path in routes/flipdesk-ebay.ts), or survive the seller ending
// the listing and eBay purging the image. Adopting the photo fixes all three.

/** eBay serves every listing render from these. Anything else is not a picture. */
export const EBAY_PHOTO_HOSTS = ["ebayimg.com", "ebaystatic.com"] as const;

/**
 * eBay's own ceiling on pictures per listing, so a well-formed listing can never
 * exceed it. A bound rather than a guess: a malformed response cannot make the
 * sync insert an unbounded number of rows for one item.
 */
export const MAX_MIRRORED_PHOTOS = 24;

/** Marketplace tag written to item_photos.remote_source for these rows. */
export const EBAY_REMOTE_SOURCE = "ebay";

export function isEbayPhotoUrl(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return EBAY_PHOTO_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/**
 * Rewrites an eBay picture URL to its full-size render.
 *
 * GetMyeBaySelling hands back PictureDetails.GalleryURL, which is a 140px
 * thumbnail, and the same picture arrives from GetItem at 1600px. Left alone,
 * an item's hero would be a 140px image and the two calls would disagree about
 * the SAME photo, so the dedupe would insert it twice. Upgrading before the
 * dedupe makes the URL the stable identity of the picture rather than of the
 * render eBay happened to name.
 *
 * Only the modern EPS form is rewritten (a `/s-l<digits>.<ext>` filename, with
 * an optional `/thumbs` prefix on the path). The pre-2015 `$_57.JPG` form is
 * already the largest variant and is returned unchanged.
 */
export function upgradeEbayPictureUrl(url: string): string {
  return url
    .replace(/\/thumbs\/images\//, "/images/")
    .replace(/\/s-l\d+(\.[A-Za-z]+)(?=$|[?#])/, "/s-l1600$1");
}

/**
 * Flattens whatever eBay returned into a clean, ordered, deduped URL list.
 *
 * Deliberately tolerant of shape. PictureDetails.PictureURL is a string for a
 * one-picture listing and an array otherwise; product.imageUrls is an array of
 * strings; and a malformed response can nest either. Deliberately INtolerant of
 * host: a URL that is not on eBay's CDN is dropped rather than hot-linked, so a
 * bad response cannot make the app render an arbitrary third-party image.
 */
export function normalizeEbayPictureUrls(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const walk = (v: unknown, depth: number): void => {
    if (out.length >= MAX_MIRRORED_PHOTOS || depth > 4) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    // fast-xml-parser folds an element with attributes into { "#text": … }.
    if (v && typeof v === "object") {
      walk((v as { "#text"?: unknown })["#text"], depth + 1);
      return;
    }
    if (typeof v !== "string") return;
    const trimmed = v.trim();
    if (!trimmed || !isEbayPhotoUrl(trimmed)) return;
    const url = upgradeEbayPictureUrl(trimmed);
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  walk(raw, 0);
  return out;
}

/** The subset of an item_photos row this planner needs to decide. */
export interface ExistingPhoto {
  remote_source: string | null;
  remote_source_url: string | null;
}

/** One item_photos row the caller should insert. */
export interface MirrorInsert {
  photo_type: "front" | "detail";
  photo_url: string;
  storage_path: null;
  remote_source: string;
  remote_source_url: string;
  sort_order: number;
}

/**
 * Decides which of eBay's pictures to add to an item, and refuses to touch a
 * photo set the seller owns.
 *
 * TWO RULES, both about not being clever with someone else's photos.
 *
 * 1. HANDS OFF AN OWNED SET. If the item carries even one photo GradeThread
 *    holds the file for (remote_source NULL — an upload, a phone capture, or an
 *    eBay picture the seller has since adopted), nothing is added. The seller
 *    has curated this item and a sync appending twelve near-duplicates behind
 *    their back is not a sync, it is vandalism. An item whose only photos are
 *    eBay references is still eBay's to keep in step.
 *
 * 2. DEDUPE ON THE URL, NOT THE POSITION. remote_source_url survives adoption
 *    precisely so this comparison keeps working after the bytes become ours —
 *    which is also why rule 1 reads remote_source and this reads
 *    remote_source_url. They answer different questions.
 *
 * Returns rows in eBay's own order, numbered after whatever is already there.
 */
export function planPhotoMirror(
  urls: string[],
  existing: ExistingPhoto[],
): MirrorInsert[] {
  if (existing.some((p) => p.remote_source == null)) return [];

  const known = new Set(
    existing
      .map((p) => p.remote_source_url)
      .filter((u): u is string => typeof u === "string" && u.length > 0),
  );

  const inserts: MirrorInsert[] = [];
  let sortOrder = existing.length;
  for (const url of urls) {
    if (known.has(url)) continue;
    known.add(url);
    inserts.push({
      // The first picture eBay lists is the one buyers see in search, so it is
      // the front. Everything after is a detail — eBay carries no per-photo
      // role, and guessing one from position past the first would be invention.
      photo_type: sortOrder === 0 ? "front" : "detail",
      photo_url: url,
      storage_path: null,
      remote_source: EBAY_REMOTE_SOURCE,
      remote_source_url: url,
      sort_order: sortOrder,
    });
    sortOrder += 1;
    if (sortOrder >= MAX_MIRRORED_PHOTOS) break;
  }
  return inserts;
}
