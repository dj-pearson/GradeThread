// Responsive-image helpers (US-306) built on Cloudflare Image Resizing.
//
// Cloudflare serves transformed variants from the `/cdn-cgi/image/<options>/<src>`
// path on the zone. `format=auto` content-negotiates AVIF → WebP → original by
// the request's Accept header (so we get modern formats with a fallback without
// generating/storing derivatives), `fit=scale-down` never upscales, and
// `onerror=redirect` falls back to the untransformed original if a particular
// image can't be resized. The plain `src` we render is always the ORIGINAL, so
// browsers without srcset support still get a working image.
//
// PREREQUISITE: Image Resizing must be enabled on the Cloudflare zone (a one-time
// setting). See vault/40-growth/seo-performance-images.md / the PR notes.

/** Default candidate widths if a caller doesn't specify any. */
export const DEFAULT_IMAGE_QUALITY = 80;

/**
 * The ONLY host this zone's resizer will serve. Subdomains are NOT included —
 * see resizerServes.
 */
const ZONE_APEX = "gradethread.com";

/**
 * Whether Cloudflare's resizer will actually serve this source.
 *
 * US-3196: it will not serve an origin that is not on the zone, and the way it
 * says so is 403 with no body. `onerror=redirect` does not catch that, because
 * the request never reaches the fetch that option guards. Measured against
 * production: the resizer answers 403 for an i.ebayimg.com source and 200 for
 * the same options over a same-origin path.
 *
 * This started mattering the moment the eBay sync began mirroring listing
 * photos by reference (the edge's lib/ebay-photo-mirror.ts). Twenty grid tiles
 * on one draft page were pointed at the resizer, every one 403, while the
 * full-size preview rendered the same photo perfectly because it never comes
 * through here. That reads as "the photo is missing from the grid", which is a
 * long way from "an image proxy refused a third-party origin".
 *
 * So the rule is now what it should always have been: transform what we serve,
 * pass through what we do not. A third-party URL comes back untouched, which
 * costs a larger download and renders correctly, instead of being rewritten
 * into a URL that cannot render at all.
 *
 * US-3187 CORRECTION: "on the zone" was measured only against a same-origin
 * path, and the subdomain half of the rule was an assumption. It is wrong.
 * Cloudflare's allowed-origins list for Transformations holds the apex and
 * nothing else, and every subdomain answers
 * `403 ERROR 9401: Transformation origin is not in allowed origins list`.
 * Measured on production 2026-09-09: root-relative 200, https://gradethread.com
 * 200, api./cdn./www./functions.gradethread.com all 403.
 *
 * That 403 is what made a composer photo vanish the moment its edit was saved.
 * persistPhotoEdit clears `thumbnail_url` on purpose (the pre-generated thumb
 * still holds the pre-edit pixels), so itemPhotoThumb falls through to
 * cfImage(photo_url) — and photo_url is on api.gradethread.com. Two tiles per
 * photo, the grid at width=320 and the eBay preview at width=96, both 403,
 * both latched to the "unavailable" placeholder by ItemPhotoImg. It came back
 * on the next page visit only because the thumbnail backfill had re-made a
 * thumbnail_url by then, which is why it read as a rendering glitch.
 *
 * To transform api.gradethread.com again, add it under Cloudflare → Images →
 * Transformations → allowed origins for this zone, THEN widen this list. Not
 * the other way round.
 */
function resizerServes(src: string): boolean {
  if (!src.startsWith("http")) return true; // root-relative: our own origin
  try {
    return new URL(src).hostname.toLowerCase() === ZONE_APEX;
  } catch {
    // Not a URL we can reason about. Leaving it alone is the safe direction:
    // the worst case is an untransformed image, not a broken one.
    return false;
  }
}

/**
 * Build a Cloudflare Image Resizing URL for `src` at the given pixel width.
 * `src` may be a root-relative path ("/logo.png") or an absolute URL on this
 * zone. Returns `src` unchanged for empty/data/already-transformed inputs, and
 * for any origin the resizer will not serve, so it is safe to call
 * unconditionally on a URL of unknown provenance.
 */
export function cfImage(
  src: string,
  width: number,
  quality: number = DEFAULT_IMAGE_QUALITY,
): string {
  if (!src || src.startsWith("data:") || src.includes("/cdn-cgi/image/")) {
    return src;
  }
  if (!resizerServes(src)) return src;
  const opts = `width=${width},quality=${quality},format=auto,fit=scale-down,onerror=redirect`;
  // Same-origin paths drop their leading slash; absolute URLs are appended whole.
  const source = src.startsWith("http") ? src : src.replace(/^\//, "");
  return `/cdn-cgi/image/${opts}/${source}`;
}

/** Build a `srcset` string (`<url> <w>w, …`) for the given candidate widths. */
export function buildSrcSet(
  src: string,
  widths: number[],
  quality: number = DEFAULT_IMAGE_QUALITY,
): string {
  if (!src || src.startsWith("data:")) return "";
  return widths
    .filter((w) => w > 0)
    .map((w) => `${cfImage(src, w, quality)} ${w}w`)
    .join(", ");
}

/** True when Cloudflare Image Transformations are confirmed enabled on the zone. */
const CF_IMAGE_RESIZING_ENABLED =
  import.meta.env.VITE_CF_IMAGE_RESIZING === "true";

/**
 * Canonical render width (px) of a FlipDesk photo grid/canvas/uploader cell.
 * Pre-generated thumbnails (US-413) target ~320w, so grid img elements never need
 * the 2400w original.
 */
const FLIPDESK_THUMB_WIDTH = 320;

/**
 * Best display source for a stored `item-photos` row in a grid/canvas/uploader
 * cell (US-574 CDN/thumbnail layer). Resolution order:
 *
 *   1. The pre-generated thumbnail (`thumbnail_url`, ~320w WebP from US-413) —
 *      so a photo-heavy grid pulls ~KBs, not the multi-MB full-res original.
 *   2. For legacy rows that predate thumbnail generation (no `thumbnail_url`),
 *      route the full-res original through Cloudflare Image Transformations at
 *      `width` when the zone supports it (VITE_CF_IMAGE_RESIZING="true") so even
 *      the long tail is downsized at the edge instead of served full-res.
 *   3. Otherwise the original `photo_url` unchanged (always 200s, just larger).
 *
 * Safe to call with partial/empty rows (returns "" when neither URL exists).
 * Hero / full-screen / AI-submission renders should NOT use this — they want
 * the original.
 */
export function itemPhotoThumb(
  photo: { thumbnail_url?: string | null; photo_url?: string | null },
  width: number = FLIPDESK_THUMB_WIDTH,
): string {
  const thumb = photo.thumbnail_url;
  if (thumb) return thumb;
  const full = photo.photo_url ?? "";
  if (!full) return "";
  return CF_IMAGE_RESIZING_ENABLED ? cfImage(full, width) : full;
}
