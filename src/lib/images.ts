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
// setting). See docs/SEO_PERFORMANCE.md / the PR notes.

/** Default candidate widths if a caller doesn't specify any. */
export const DEFAULT_IMAGE_QUALITY = 80;

/**
 * Build a Cloudflare Image Resizing URL for `src` at the given pixel width.
 * `src` may be a root-relative path ("/logo.png") or an absolute URL
 * (an R2/CDN image). Returns `src` unchanged for empty/data/already-transformed
 * inputs so it's safe to call unconditionally.
 */
export function cfImage(
  src: string,
  width: number,
  quality: number = DEFAULT_IMAGE_QUALITY,
): string {
  if (!src || src.startsWith("data:") || src.includes("/cdn-cgi/image/")) {
    return src;
  }
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
 * Pre-generated thumbnails (US-413) target ~320w, so grid `<img>`s never need
 * the 2400w original.
 */
export const FLIPDESK_THUMB_WIDTH = 320;

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
