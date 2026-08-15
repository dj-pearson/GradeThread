// Relative, not the `@/` alias: vite.config.ts imports this file and the
// config is bundled before the tsconfig paths alias exists.
import { PUBLIC_ROUTES } from "../seo/public-routes";

// US-421: every navigation that MUST reach the network/edge to get the correct
// per-route HTML — the prerendered static pages (their own crawlable <head>) and
// the dynamic Pages Functions (blog/cert/og/sitemaps SSR) — rather than the
// service worker's generic /index.html SPA shell. Without this the SW bypasses
// the entire prerender/SSR investment by handing every navigation the cached
// shell. The prerendered-route entries are derived from the SEO registry so new
// marketing/glossary pages are excluded automatically.
//
// Lives here rather than inline in vite.config.ts so the list is testable: a
// missing entry is a soft 404 that only shows up on a device with the service
// worker already installed, which no build step can catch.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A navigation to a real file that ships in `public/` — a PDF, an image, a
// .txt. `window.open("/measure-card-letter-v2.pdf")` is a navigation, so
// without this entry the SW answers it with the cached SPA shell and the
// router renders its 404 over a file the edge serves with a 200. `.html` is
// excluded because those ARE shells. Workbox tests the denylist against
// `pathname + search`, hence the optional `?`.
// The upper bound is 12 so `.webmanifest` fits.
export const STATIC_FILE_NAVIGATION = /\.(?!html?(?:$|\?))[a-z0-9]{2,12}(?:$|\?)/i;

export const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [
  // API + dynamic, server-rendered Pages Functions (functions/*).
  /^\/api\//,
  /^\/blog(\/|$)/,
  /^\/cert\//,
  /^\/badge\//,
  /^\/slab\//,
  /^\/verified\//,
  /^\/condition-index(\/|$)/,
  /^\/finds(\/|$)/,
  /^\/value(\/|$)/,
  /^\/durability(\/|$)/,
  /^\/og\//,
  /^\/\.well-known\//,
  /^\/(sitemap.*\.xml|robots\.txt|llms\.txt|rss\.xml|csp-report)$/,
  STATIC_FILE_NAVIGATION,
  // Prerendered static routes (marketing, legal, glossary spokes). Each is a
  // real per-route index.html on the edge with its own <head>; the root "/"
  // is intentionally left to the navigateFallback (it IS dist/index.html).
  ...PUBLIC_ROUTES.map((r) => r.path)
    .filter((p) => p !== "/")
    .map((p) => new RegExp(`^${escapeRegExp(p)}/?$`)),
];

/** True when the service worker must let this path hit the network. */
export function isNavigateFallbackDenied(pathnameAndSearch: string): boolean {
  return NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(pathnameAndSearch));
}
