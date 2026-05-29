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
