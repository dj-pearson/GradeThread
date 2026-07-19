---
title: Web vitals, images and edge caching
type: reference
status: current
source_of_truth: code
code_refs:
  - src/lib/images.ts
  - functions/_shared/blog-render.ts
reviewed: 2026-07-19
tags: [seo, performance, images, cwv]
summary: The shipped performance levers, the Cloudflare toggles still to enable, and how responsive images are actually gated.
---
# Core Web Vitals + edge caching (US-1690)

The SPA + edge-SSR + Cloudflare stack tuned so ranking and crawl quality hold as
certificate/pSEO volume grows. Most levers were already in place; this records
what's shipped, what's a Cloudflare toggle, and how to verify.

Three documents used to cover this — `CORE_WEB_VITALS.md`, `IMAGE_OPTIMIZATION.md`
and the CWV half of `SEO_PERFORMANCE.md`. They described the same shipped levers
with duplicated constants and one outright contradiction, so US-2054 merged them
into the single account below and resolved the disagreement against the code
(see Corrections).

## Budgets

| Metric | Budget | Why |
|---|---|---|
| **LCP** | < 2.5 s | On marketing pages the LCP element is the hero `<h1>` text, so it is gated by font and render-blocking cost, not an image. |
| **CLS** | < 0.1 | Above-the-fold images carry intrinsic `width`/`height`; the cookie banner is a fixed overlay, so it adds no flow shift. |
| **INP** | < 200 ms | Field-only (needs real interactions). CI uses **TBT < 200 ms** as the lab proxy. |
| **TTFB** | reported | Diagnostic context for LCP; not budgeted in CI. |
| Lighthouse **Performance** | ≥ 0.90 | Composite guardrail. |

Thresholds live in `lighthouserc.json` at `warn` level, non-blocking.

## What ships in code

**Layout stability (CLS).** Inter is self-hosted with `font-display: swap`
(`src/index.css`) and preloaded from `index.html`, so the hero H1 paints in the
system fallback and swaps without shifting. Every public image carries explicit
`width`/`height` or an `aspect-ratio`: the `<Image>` component
(`src/components/responsive-image.tsx`) *requires* those props, and the blog SSR
(`functions/_shared/blog-render.ts`) emits them on hero and content images.

**Responsive images (US-306), and how they are gated.** `<Image>` and the blog
SSR emit a Cloudflare `srcset` + `sizes` **only** when
`VITE_CF_IMAGE_RESIZING === "true"` (`CF_IMAGE_RESIZING_ENABLED`,
`src/lib/images.ts:52`). Every candidate URL is built by `cfImage()` with
`onerror=redirect` (`images.ts:31`), so a transform that fails serves the
untransformed original rather than a broken image. With the flag off, the plain
original ships and nothing degrades.

**Bundle and interaction (INP).** Marketing routes are `React.lazy()` in
`src/routes/index.tsx`, keeping the auth/dashboard/Supabase/Radix graph out of the
eager entry chunk — marketing pages do not ship the ~80 KB gz they never use.
Prerendered pages render as static HTML and `createRoot`-mount over the shell
rather than hydrating heavily. `/assets/*` and `/fonts/*` get an immutable
year-long cache (`public/_headers`).

**TTFB.** Edge-SSR'd blog and certificate HTML is cached stale-while-revalidate:
`SSR_CACHE_CONTROL = "public, max-age=300, s-maxage=3600,
stale-while-revalidate=86400"` (`functions/_shared/blog-render.ts`), so TTFB stays
flat as certificate volume grows.

**Early Hints.** `public/_headers` emits a `Link: </fonts/inter-latin.woff2>;
rel=preload` header on `/*`, which Cloudflare converts into a 103 Early Hints
response once the toggle below is on.

**Field CWV.** Real-user vitals are collected via `web-vitals` (US-305,
`src/lib/web-vitals.ts`), consent-gated.

## Ops toggles — the human steps still outstanding

All three are Cloudflare dashboard actions. None are done in code.

| Toggle | Where | Effect |
|---|---|---|
| **Image Transformations** | Speed → Optimization → Image Optimization → Transformations → Enable for this zone | `/cdn-cgi/image/…` URLs 404 until this is on. This is what actually turns on responsive `srcset`. |
| **Early Hints** | Speed → Optimization | Consumes the `Link` preload header already emitted. |
| **HTTP/3 (QUIC)** | Network | Transport-level latency. |

Enabling Transformations is two steps, not one: turn it on in the dashboard,
**then** set `VITE_CF_IMAGE_RESIZING="true"` in the Cloudflare Pages project
(Settings → Environment variables — it reaches both the Vite build and the Pages
Functions runtime, so one variable flips `<Image>` and the blog SSR together),
then redeploy.

Verify a transformed URL returns 200 rather than 404:

```bash
curl -sI "https://gradethread.com/cdn-cgi/image/width=320,format=auto/logo_primary.png" | head -n 1
curl -sI "https://gradethread.com/logo_primary.png" | head -n 1
```

A 404 on the first means Transformations is still off, or the variable is unset
or not redeployed. **The site is not broken in that state** — it serves full-size
originals. That is the current production state.

## Measurement

**Field (real users).** `src/lib/web-vitals.ts` subscribes to LCP, INP, CLS and
TTFB and reports each once per page load. `startWebVitals()` runs only from
`startAnalytics()`, i.e. after cookie consent — decliners send nothing and the
`web-vitals` chunk is never downloaded. Data lands in GA as a `web_vitals` event
and in PostHog as a `web_vitals` capture, both carrying `metric_name`,
`metric_value`, `metric_rating`, `metric_id`, `navigation_type`. CLS is sent ×1000
as an integer (0.043 → `43`); the rest are whole milliseconds.

**Lab (CI).** `.github/workflows/lighthouse.yml` builds the prerendered `dist/`
(the same HTML bots see), runs Lighthouse against `/`, `/condition-grading` and
`/how-it-works` (desktop preset, 3 runs, median), asserts budgets at `warn`, and
upserts a non-blocking PR comment. It is `continue-on-error` — the merge gate is
`ci.yml`, not this. Locally: `npm run build && npx @lhci/cli autorun --config=./lighthouserc.json`.

## Verifying no regression

Run Lighthouse (mobile profile) and check field data on one URL of each type: a
marketing pillar (`/grading/scale`), a blog post, a certificate (`/cert/:id`) and
a pSEO page (`/grading/glossary/euc`). Confirm the LCP element is the prerendered
hero rather than a hydrated swap-in, CLS ≈ 0, INP within budget, and that the
crawlable content is unchanged. The prerender parity audit (US-1669) already
fails the build if hydration strips content — see [[seo-technical-guards]].

Image sitemap:

```bash
curl -s https://gradethread.com/sitemap-images.xml | head -n 20
curl -s https://gradethread.com/robots.txt | grep -i sitemap
```

## Adding a new marketing image

1. Add it to `ROUTE_OG_IMAGES` in `src/lib/seo/public-routes.ts`, with `alt`.
2. Mirror it into `MARKETING_IMAGES` in `functions/_shared/sitemap.ts` — Pages
   Functions cannot import from `src/`, which is why this is two edits in
   lockstep rather than one.

Blog hero images need no manual step; they reach the image sitemap from
`/api/content/public/sitemap.json`. For the *route* itself, follow
[[seo-public-route-registry]] — those steps are not restated here.

---

## App runtime performance (not SEO)

The three sections below came from `SEO_PERFORMANCE.md` but are **application
performance, not growth**: they affect logged-in FlipDesk users, not crawlers or
marketing pages. They are kept here because no app-performance note exists yet;
move them when one does.

## FlipDesk listing-photo thumbnails + CDN layer (US-574)

Public `item-photos` (the reseller's listing imagery) are the most photo-heavy
surface in the app — the pipeline canvas, photo-manager grid, AutoLister picker,
and eBay preview can each render dozens of cells at once. Serving the full-res
original (≈2400w, multi-MB) into a 96–320px grid cell is pure wasted Storage
egress and a slow LCP.

Two-tier strategy:

1. **Pre-generated thumbnails (primary).** On upload, `photo-uploader.tsx` /
   `use-reconcile-commit.ts` bake a **~320w WebP** thumbnail through the same
   canvas pipeline as the full image (EXIF-stripped, upright) and persist it as
   `item_photos.thumbnail_url` / `thumbnail_storage_path` (US-413). No
   Cloudflare feature is required — these are plain objects in the public
   `item-photos` bucket.
2. **Cloudflare Image Transformations (fallback for the legacy tail).** Rows
   uploaded **before** thumbnail generation have no `thumbnail_url`. When the
   zone supports Transformations (`VITE_CF_IMAGE_RESIZING="true"`), those
   originals are routed through `/cdn-cgi/image/width=…` at the cell width so
   even the long tail is downsized at the edge; when the flag is off they fall
   back to the untransformed original (always 200s, just larger).

Single helper — **`itemPhotoThumb(photo, width?)` in `src/lib/images.ts`** —
encodes that order (thumbnail → CF-transformed original → original). Every
grid/canvas/uploader/preview `<img>` calls it instead of an ad-hoc
`thumbnail_url ?? photo_url`, so the CDN tier turns on everywhere the moment the
flag flips. Hero / full-screen / AI-submission renders deliberately keep the
original (they want full resolution).

### Expected egress + LCP improvement

A 320w WebP thumbnail is ≈15–30 KB versus a ≈1.5–3 MB full-res JPEG — roughly a
**98% byte reduction per grid image**. On a 12-photo pipeline canvas that is
~18–36 MB → ~0.2–0.4 MB of image transfer, which is the dominant LCP cost on
that page once it was already past the SSR/text paint. **Measurement method**
(run on a photo-heavy item with ≥10 photos, before/after this change):

- **Storage egress:** Cloudflare zone Analytics → `item-photos` path, or the
  Supabase Storage egress metric over a fixed browse session.
- **LCP:** the in-app RUM (`src/lib/web-vitals.ts`) reports LCP for the
  `/dashboard/flipdesk/*` routes; compare the p75 before/after, or use a Lighthouse
  run against a seeded photo-heavy item.

Record the before/after numbers in the launch sign-off; the flag flip + a
re-measure is tracked alongside the US-306 Transformations enablement.

## Visibility-gated background polling (US-576)

Several screens poll on a timer. Left ungated, every open-but-hidden tab keeps
hitting the edge/DB forever. We gate each poller on `document.visibilityState`
via the `useDocumentVisible()` hook (`src/hooks/use-document-visible.ts`): when
the tab is hidden the interval is torn down, and on return to the foreground the
poll reschedules (TanStack Query also fires an immediate `refetchOnWindowFocus`).

| Surface | Before | After (visible) | After (hidden) |
|---|---|---|---|
| Notification center (`notification-center.tsx`) | 30s poll | 60s poll¹ | **0** (realtime INSERTs still deliver) |
| Admin dashboard (`admin/dashboard.tsx`) | 60s poll | 60s poll | **0** |
| Admin system (`admin/system.tsx`) | 30s poll | 30s poll | **0** |
| Submission detail (`submission-detail.tsx`) | 5s `setInterval` while grading | 5s while grading | **0** (realtime still delivers status) |

¹ Notification polling widened 30s→60s because realtime `postgres_changes`
INSERTs are the primary delivery path; the poll is only a reconnect fallback.

### Expected request-volume reduction per idle tab

Per **hidden** tab, background request volume drops to **zero** for all four
surfaces (down from 2 req/min on the notification center, 1–2 req/min on the
admin pages, and 12 req/min on an in-flight submission detail). Across a typical
session with several backgrounded tabs this removes the steady idle baseline
entirely. **Measurement method:** open the surface, switch to another tab, and
watch the Network panel (or the edge access log for that user) — confirm the
recurring request stops within one interval of hiding and resumes on focus.

## Edge-cached dynamic public SSR surfaces (US-577)

The shared/crawled public pages are server-rendered by Cloudflare Pages
Functions, not static HTML: certificates (`functions/cert/[id].ts`), verified
seller profiles (`functions/verified/[handle].ts`), and the blog
(`functions/blog/[[path]].ts`). These are the surfaces link-preview bots and
search/AI crawlers hammer, and they re-render the same HTML for every hit.

**Why a Cache-Control header alone isn't enough.** Every SSR response already
carries `SSR_CACHE_CONTROL` (`public, max-age=300, s-maxage=3600,
stale-while-revalidate=86400`). But Cloudflare Pages Functions are **not** cached
by the colo by default — `s-maxage` only instructs *downstream* shared caches, so
without more the colo re-renders on every request. We wrap each render in the
**Cache API** (`caches.default`) via `withEdgeCache()` in
`functions/_shared/blog-render.ts`, which gives a genuine edge HIT on repeat
requests:

- Keyed on **origin + pathname** (query string ignored) so `?utm_*`-tagged share
  links collapse onto one entry and can't fragment or poison the cache.
- Only `GET` `200` responses with a public `Cache-Control` are stored — the blog
  `preview` route (`private, no-store`) and 404/503s are passed through untouched.
- Adds `x-gt-cache: HIT|MISS` so a HIT is verifiable, and stores via `waitUntil()`
  so the first (MISS) response isn't blocked.
- Degrades to a plain render when `caches` is unavailable (local `wrangler`).

**Purge on publish / score-change.** A cached page must not outlive its data.
The existing `lib/cloudflare-purge.ts` plumbing is extended with
`buildCertPurgeFiles()` / `buildSellerPurgeFiles()` and best-effort wrappers
`purgeCertificateCache()` / `purgeSellerProfileCache()` (no-op + no DB hit when
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID` are unset; never throw). They evict
the cert SSR page **plus** its OG/badge/slab image renderers (all encode the
score), or the profile SSR page + its OG card. Wired into every write that
changes the data:

| Trigger | Code | Purges |
|---|---|---|
| Dispute resolved with a grade change | `routes/admin-disputes.ts` | `/cert/:id` (+ og/badge/slab) |
| Review-queue grade adjustment | `routes/admin-grading.ts` | `/cert/:id` (+ og/badge/slab) |
| Seller edits/toggles their profile (incl. handle rename → old+new) | `routes/verified.ts` | `/verified/:handle` (+ og) |
| Blog publish/edit/unpublish | `routes/content-blog.ts`, `content-scheduler.ts` (pre-existing) | `/blog/:slug`, `/blog`, sitemap, rss |

### Verifying a cache HIT

```bash
curl -sI https://gradethread.com/cert/<id> | grep -i 'x-gt-cache\|cache-control'
curl -sI https://gradethread.com/cert/<id> | grep -i 'x-gt-cache'   # → x-gt-cache: HIT
```

After a grade change or profile edit the next request is a MISS again (the write
purged the URL), then HITs resume. The `withEdgeCache` HIT/MISS contract and the
private/error skip guards are unit-tested in `src/test/edge-cache.test.ts`.

---

## Corrections — resolved against code 2026-07-19 (US-2054)

The three documents merged here disagreed with each other. Resolved by reading
`src/lib/images.ts`, not by picking the longer file.

### Responsive images: both docs were half right

`IMAGE_OPTIMIZATION.md` said a failed `/cdn-cgi/image/` candidate does **not**
fall back to `src`. **That is wrong.** `cfImage()` builds every candidate with
`onerror=redirect` (`images.ts:31`), which is precisely Cloudflare's
fall-back-to-the-original behaviour, and the file's own header comment says so.

`SEO_PERFORMANCE.md` said the plain `src` is always the untransformed original.
**That is right**, and independently true of the fallback.

The two facts are complementary, not contradictory:

1. `srcset` is emitted **only** when `VITE_CF_IMAGE_RESIZING === "true"`
   (`CF_IMAGE_RESIZING_ENABLED`, `images.ts:52`) — the zone-support gate.
2. When it *is* emitted, each candidate carries `onerror=redirect`, so a
   transform failure serves the original rather than a broken image.

So the failure mode the docs argued about cannot happen in either direction.
Cloudflare Image Transformations remain **off** on the zone (`/cdn-cgi/image/`
404s), which is why the flag defaults to off.

### Route counts: two different metrics, never labelled

`SEO_STRATEGY.md` said 38 routes; `SEO_INDEXABILITY_ACTION_PLAN.md` said 213
URLs. Neither was lying — they count different things, and neither said which:

- **41** entries in `PUBLIC_ROUTES` (`src/lib/seo/public-routes.ts`, counted
  2026-07-19) — the *registry*, i.e. distinct route patterns.
- **213** indexable URLs — the registry *after template expansion*, where one
  pSEO pattern becomes many concrete URLs.

Quote the metric you mean. The gap between them is the whole subject of
[[seo-indexability]].

### `/transparency` is prerendered, not client-rendered

`SEO_STRATEGY.md` listed it as client-rendered and therefore invisible to
JS-less AI crawlers. It is registered in `PUBLIC_ROUTES` and mounted in
`entry-server.tsx:160`, so it prerenders. `PRERENDER_PARITY.md` was right to
cite it as the correct pattern. The strategy doc's audit snapshot was written
2026-06-27 and had simply aged.

## Related

- [[seo-technical-guards]] — what CI enforces about the same output
- [[seo-public-route-registry]] — route wiring, not restated here
- [[INDEX]]
