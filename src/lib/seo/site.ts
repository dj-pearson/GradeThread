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
