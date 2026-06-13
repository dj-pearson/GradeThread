# SEO performance — Core Web Vitals (US-305)

GradeThread tracks Core Web Vitals (CWV) both in the field (real users) and in
CI (lab), because the March 2026 Google core update weights the "good" CWV band
more heavily, and **INP < 200 ms** is the most commonly failed metric.

## Budgets

| Metric | Budget | Why |
|---|---|---|
| **LCP** (Largest Contentful Paint) | < 2.5 s | "Good" threshold. On marketing pages the LCP element is the hero `<h1>` text, so it's gated by font + render-blocking cost, not an image. |
| **CLS** (Cumulative Layout Shift) | < 0.1 | "Good" threshold. Above-the-fold images carry intrinsic `width`/`height`; the cookie banner is a fixed overlay (no flow shift). |
| **INP** (Interaction to Next Paint) | < 200 ms | "Good" threshold. Field-only (needs real interactions). In CI we use **TBT < 200 ms** as the lab proxy. |
| **TTFB** (Time To First Byte) | reported | Diagnostic context for LCP; not budgeted in CI. |
| Lighthouse **Performance** | ≥ 0.90 | Composite guardrail. |

These thresholds live in [`lighthouserc.json`](../lighthouserc.json) at `warn`
level (non-blocking).

## Field measurement (real users)

`src/lib/web-vitals.ts` subscribes to **LCP, INP, CLS, and TTFB** via Google's
[`web-vitals`](https://github.com/GoogleChrome/web-vitals) library and reports
each once per page load.

- **Consent-gated.** `startWebVitals()` is invoked only from `startAnalytics()`
  (`src/lib/analytics.ts`), which runs *after* the visitor accepts the cookie
  banner. Decliners send nothing, and the `web-vitals` chunk is lazy-imported so
  it never downloads for them.
- **Where the data lands:**
  - **Google Analytics** — a `web_vitals` event with params
    `metric_name`, `metric_value`, `metric_rating`, `metric_id`,
    `navigation_type` (`non_interaction: true`).
  - **PostHog** — a `web_vitals` capture with the same fields (when PostHog is
    loaded). Build a CWV insight by filtering on `metric_name` and charting the
    median / p75 of `metric_value`, split by `metric_rating`.
  - CLS is sent ×1000 as an integer (e.g. 0.043 → `43`); LCP/INP/TTFB are whole
    milliseconds.

## Lab measurement (CI)

The [`Lighthouse CI`](../.github/workflows/lighthouse.yml) workflow runs on every
PR:

1. `npm run build` produces the **prerendered** `dist/` (same HTML bots see).
2. `treosh/lighthouse-ci-action` runs Lighthouse (desktop preset, 3 runs, median)
   against the static `dist/` for `/`, `/condition-grading`, and `/how-it-works`.
3. Budgets are asserted at `warn` level; the step is `continue-on-error`, so the
   workflow **never blocks a merge** — the merge gate is `ci.yml`.
4. A **non-blocking PR comment** is upserted with the per-page scores and links
   to the full reports (temporary public storage, ~7-day retention).

To run it locally:

```bash
npm run build
npx @lhci/cli autorun --config=./lighthouserc.json
```

## Layout-shift & LCP safeguards in the codebase

- **Fonts:** Inter is loaded non-render-blocking in `index.html`
  (`<link rel="preload" as="style" onload=…>`), with `display=swap` and a
  system-font fallback stack in `src/index.css`, so hero text paints immediately
  and swaps to Inter when ready.
- **Above-the-fold images:** the header logo carries explicit `width`/`height`
  + `fetchPriority="high"`; footer logos are `loading="lazy"`.
- **Cookie banner:** fixed overlay with a reserved `min-h-20`, so it neither
  shifts document flow nor reflows its own box as it mounts.

## Responsive images (US-306)

Public images are served responsively through **Cloudflare Image Resizing**
(`/cdn-cgi/image/<options>/<src>`), so no derivatives are stored:

- `format=auto` content-negotiates **AVIF → WebP → original** by the request's
  `Accept` header (modern formats with a built-in fallback).
- `fit=scale-down` never upscales; `quality=80`.
- `onerror=redirect` serves the **untransformed original** if a specific image
  can't be resized — and the plain `src` we render is always the original, so
  non-`srcset` clients still get a working image.

Helpers: `src/lib/images.ts` (`cfImage`, `buildSrcSet`) + the reusable
`<Image>` component (`src/components/responsive-image.tsx`) for React pages, and
the mirror copy in `functions/_shared/blog-render.ts` (`cfImage`,
`buildSrcSet`, `renderHeroImage`, `rewriteContentImages`) for the blog SSR. The
blog hero is eager + `fetchpriority=high` (it's the LCP); in-body content
images get a `srcset` + `loading=lazy`.

> **Prerequisite:** Image Resizing must be enabled on the Cloudflare zone (a
> one-time dashboard/Speed → Optimization setting). Until it is, `/cdn-cgi/image/`
> URLs 404; `onerror=redirect` only covers per-image transform failures, not the
> feature being disabled. The rendered `src` fallback keeps the base image
> working regardless.

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
# First request warms the colo (MISS); the second is served from the edge (HIT).
curl -sI https://gradethread.com/cert/<id> | grep -i 'x-gt-cache\|cache-control'
curl -sI https://gradethread.com/cert/<id> | grep -i 'x-gt-cache'   # → x-gt-cache: HIT
```

After a grade change or profile edit the next request is a MISS again (the write
purged the URL), then HITs resume. The `withEdgeCache` HIT/MISS contract and the
private/error skip guards are unit-tested in `src/test/edge-cache.test.ts`.
