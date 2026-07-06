# Core Web Vitals + edge caching (US-1690)

The SPA + edge-SSR + Cloudflare stack tuned so ranking and crawl quality hold as
certificate/pSEO volume grows. Most levers were already in place; this records
what's shipped, what's a Cloudflare toggle, and how to verify.

## Shipped (in code)

**CLS**
- **Self-hosted Inter with `font-display: swap`** (`src/index.css` `@font-face`),
  preloaded in `index.html` — the hero H1 (LCP) paints in the system fallback
  and swaps without layout shift. No JS-driven font injection.
- **Explicit `width`/`height` on images** via the responsive `<Image>` component
  (`src/components/responsive-image.tsx`), used across marketing/layout. New
  marketing/pSEO pages are text-first and add no unsized raw `<img>`.

**INP / bundle**
- **Marketing routes are code-split from the app bundle**: every page is
  `React.lazy()` in `src/routes/index.tsx`, and the auth/dashboard/Supabase/Radix
  graph is kept OUT of the eager entry chunk (see the router header comment) — the
  landing + marketing pages don't ship the ~80KB gz of supabase+radix they never
  use. The prerendered pages render as static HTML and `createRoot`-mount over
  the shell (not heavy hydration).
- Immutable year-long cache on `/assets/*` and `/fonts/*` (`public/_headers`).

**TTFB / edge caching**
- Edge-SSR'd blog + certificate HTML is cached with **stale-while-revalidate**:
  `SSR_CACHE_CONTROL = "public, max-age=300, s-maxage=3600,
  stale-while-revalidate=86400"` (`functions/_shared/blog-render.ts`), so TTFB
  stays flat as cert volume grows.

**Early Hints**
- `public/_headers` emits a `Link: </fonts/inter-latin.woff2>; rel=preload; …`
  header on `/*`, which Cloudflare turns into a **103 Early Hints** response for
  the LCP font once Early Hints is enabled (below).

**Field CWV**
- Real-user Core Web Vitals are collected via `web-vitals` (US-305,
  `src/lib/web-vitals.ts`, consent-gated), and a mobile Lighthouse profile exists
  (US-974) for lab CWV.

## Cloudflare dashboard toggles (ops — one-time)

- **Early Hints**: Speed → Optimization → enable Early Hints (consumes the `Link`
  preload header above).
- **HTTP/3 (with QUIC)**: Network → enable HTTP/3.

## Verify (no prerender-content regressions)

Run Lighthouse (mobile profile) + check field data on one URL of each type:
- a marketing pillar (e.g. `/grading/scale`),
- a blog post,
- a certificate (`/cert/:id`),
- a pSEO page (e.g. `/grading/glossary/euc` or `/grading/guides/denim-jacket`).

For each, confirm: LCP element is the prerendered hero (not a hydrated swap-in),
CLS ≈ 0 (font swap + sized images), INP within budget, and the crawlable content
(the `crawl-parity.test.ts` set) is unchanged. The prerender parity audit
(US-1669) already fails the build if hydration strips content.
