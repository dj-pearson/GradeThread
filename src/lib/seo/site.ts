// Site-level SEO scalars — the leaf every page needs and almost none of the
// registry.
//
// WHY THIS FILE EXISTS (performance, not tidiness). These constants used to
// live in public-routes.ts alongside PUBLIC_ROUTES, which imports 17 route-data
// modules carrying the marketing prose for all 213 public routes. Those prose
// modules are reachable from both public-routes.ts and each page's own chunk,
// so Rollup hoisted them into a single SHARED chunk — and any module that
// imported so much as SITE_URL inherited the whole thing. That put ~134 KB of
// prose (89 KB gzipped, about the weight of React itself) into the EAGER graph
// of every page, including the landing page, which renders none of it. The copy
// was already in each route's prerendered HTML, so it was pure duplication.
//
// 194 references in this codebase want SITE_URL; 66 want PUBLIC_ROUTES. Keeping
// the scalars in a module with NO imports means the common case cannot pull the
// registry in.
//
// ⚠️ KEEP THIS FILE IMPORT-FREE. A single import of a route-data module here
// re-creates the exact problem it was split out to fix, and nothing about the
// resulting bundle will look obviously wrong. This is asserted by
// src/lib/seo/__tests__/site-leaf.test.ts.

export const SITE_URL = "https://gradethread.com";

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_TYPE = "image/png";
export const DEFAULT_OG_IMAGE_PATH = "/og-image.png";
export const DEFAULT_OG_IMAGE_ALT =
  "GradeThread — objective AI condition grading and verifiable certificates for pre-owned clothing.";

/** Normalize a pathname for lookup (strip trailing slash, keep root as "/"). */
export function normalizePath(path: string): string {
  if (path === "/" || path === "") return "/";
  return path.replace(/\/+$/, "");
}

/** Absolute canonical URL for a registry path. */
export function absoluteUrl(path: string): string {
  const norm = normalizePath(path);
  return norm === "/" ? `${SITE_URL}/` : `${SITE_URL}${norm}`;
}

/**
 * The branded card /og/social/card renders for a page that has no bespoke
 * social image.
 *
 * 268 of the 276 public routes shared one identical /og-image.png, so every
 * share of a fee calculator, a care guide and the pricing page unfurled as the
 * same picture. The card route is stateless — the text rides in the query
 * string — renders 1200x630 (the landscape ratio, which is exactly the
 * OG_IMAGE_WIDTH/HEIGHT this file declares) and edge-caches for a day keyed on
 * the full URL, so a page's card is rendered once and served from cache after.
 *
 * The page TITLE is the card text. Titles here are short (the longest is 46
 * characters) and none of them repeats the brand, which the card supplies
 * itself, so they need no trimming.
 *
 * ⚠ This is an og:image, NOT a content image. It deliberately does not go into
 * ROUTE_OG_IMAGES: that registry feeds the seo-manifest `image` field and from
 * there sitemap-images.xml, and an image sitemap is for pictures the page is
 * about. A social card is a picture OF the page.
 */
export function socialCardImageUrl(
  title: string,
  product: "gradethread" | "flipdesk" = "gradethread",
): string {
  const q = new URLSearchParams({
    ratio: "landscape",
    kind: "title",
    text: title,
    product,
  });
  return `${SITE_URL}/og/social/card?${q}`;
}

/** Which product's mark the card carries. FlipDesk pages get FlipDesk's. */
export function socialCardProduct(path: string): "gradethread" | "flipdesk" {
  const norm = normalizePath(path);
  return norm === "/flipdesk" || norm.startsWith("/flipdesk/")
    ? "flipdesk"
    : "gradethread";
}
