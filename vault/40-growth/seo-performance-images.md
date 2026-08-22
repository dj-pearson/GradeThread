---
title: Web vitals, images and edge caching
type: reference
status: current
source_of_truth: code
code_refs:
  - src/lib/images.ts
  - functions/_shared/blog-render.ts
  - wrangler.toml
  - lighthouserc.json
  - functions/_shared/sitemap.ts
reviewed: 2026-08-22
tags: [seo, performance, images, cwv]
summary: The shipped performance levers, how responsive images are gated (ON since US-2333), and how the edge SSR cache and its purges actually work.
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
`width`/`height` or an `aspect-ratio` — but by **two different mechanisms**, and
the note used to blur them:

- `<Image>` (`src/components/responsive-image.tsx:7,61`) genuinely *requires*
  `width`/`height` props and emits them as attributes.
- The blog SSR emits **neither**. `renderHeroImage` in `blog-render.ts` writes
  only `class/src/srcset/sizes/alt/loading/fetchpriority/decoding`; the hero's
  box is reserved by CSS instead (the `.hero { aspect-ratio: 16 / 9 }` rule in
  the same file). `rewriteContentImages` *reads* dimensions the author supplied
  and, only when both are absent and there is no `style=`, injects
  `style="aspect-ratio:auto 16/9"`.

  > Anchored by SYMBOL, not by line. This passage quoted `:1305`, `:410` and
  > `:1388`, and on 2026-08-22 all three pointed at the wrong thing — a bare
  > `}`, a table-cell CSS rule, and a comment. The file had moved under them.
  > A line number in a note is a claim that expires without anyone editing the
  > note; a symbol name fails loudly by not being found.

The CLS outcome is the same; the mechanism is not. Anyone grepping the SSR for a
`width=` attribute after reading the old sentence found nothing and had no way to
tell whether that was a bug.

**Responsive images (US-306), and how they are gated.** `<Image>` and the blog
SSR emit a Cloudflare `srcset` + `sizes` **only** when
`VITE_CF_IMAGE_RESIZING === "true"` (`CF_IMAGE_RESIZING_ENABLED`,
`src/lib/images.ts:52`). Every candidate URL is built by `cfImage()` with
`onerror=redirect` (`images.ts:31`), so a transform that fails serves the
untransformed original rather than a broken image. With the flag off, the plain
original ships and nothing degrades.

> [!caution] `onerror=redirect` does NOT make the flag safe to flip blind
> It covers a bad SOURCE image once Transformations is running. It cannot
> cover a zone where Transformations is OFF: there `/cdn-cgi/image/*` 404s
> at the edge before any transform executes, and a 404ing `srcset`
> candidate does **not** fall back to `src` — the image renders broken,
> site-wide. That asymmetry is why the order is dashboard-first, flag-
> second, and why the `curl` check below is the gate rather than a
> formality.

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

**The one inline `<head>` script, and the hash that keeps it alive.**
`index.html` carries a single inline script — Consent Mode v2 defaults, the Inter
font injection, and an idle-deferred `gtag.js`. It was inlined from a former
`/head-init.js` to remove a render-blocking round trip, which was the largest
mobile PageSpeed blocker at roughly 490ms.

The enforcing CSP allows it by **sha256 hash** in `public/_headers` `script-src`
— deliberately not `'unsafe-inline'`.

**The hash is recomputed by the build; you do not touch it.** `scripts/prerender.mjs`
calls `syncCspHash(builtIndex, headers)` (`prerender.mjs:378`, helper in
`scripts/csp-hash.mjs`), which sha256s the inline script as built and rewrites the
directive in `dist/_headers`. The build **fails loudly** if the token it expects
to replace is missing, so a silently-wrong hash is not a state you can reach.

> [!note] This section carried a manual-recompute warning until 2026-08-08
> It told you to run a `node -e` one-liner against `dist/index.html` and edit
> `public/_headers` in the same change. US-358 automated exactly that, and
> `public/_headers:5-10` has said so since. The warning was the note's most
> emphatic callout, which is precisely why it was worth deleting rather than
> softening: an emphatic instruction to do work the build already does teaches a
> reader that the emphatic callouts are noise.

The
script sits **outside** the `prerender:head` markers, so it survives into every
prerendered page.

**Field CWV.** Real-user vitals are collected via `web-vitals` (US-305,
`src/lib/web-vitals.ts`), consent-gated.

## Ops toggles — the human steps still outstanding

All three are Cloudflare dashboard actions. None are done in code.

| Toggle | Where | Effect |
|---|---|---|
| ~~**Image Transformations**~~ ✅ **DONE** | — | Verified live 2026-08-03 (US-2333): the transform URL returns **200** and `Content-Type: image/avif`. `VITE_CF_IMAGE_RESIZING` is now `"true"` in `.env.production` and `wrangler.toml` (both prod and preview), and the build emits `srcSet`. |
| **Early Hints** | Speed → Optimization | Consumes the `Link` preload header already emitted. |
| **HTTP/3 (QUIC)** | Network | Transport-level latency. |

> [!warning] This was OFF for a blocker that had already been cleared
> The dashboard toggle was enabled at some point, but the flag stayed `"false"`,
> so every image shipped full-size in its original format while the code to
> avoid that sat behind a switch waiting on a step that was already done. On
> `logo_primary.png` that was **125,781 B → 5,420 B (−95.7%)** left on the
> table. The lesson is in the shape, not the number: a two-step toggle where
> one step is a dashboard action and the other is in the repo will sit
> half-finished, because nothing fails when only one is done. The `curl` check
> below is the thing that closes it — run it rather than assuming.

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

A 404 on the first means Transformations is off, or the variable is unset or not
redeployed. **The site is not broken in that state** — `cfImage()`'s
`onerror=redirect` serves full-size originals.

That was production until US-2333 (2026-08-03). It is not any more:
`VITE_CF_IMAGE_RESIZING=true` in both `.env.production:57` and `wrangler.toml`
(prod and preview). The `curl` above should now return **200**, and a 404 is a
regression to chase rather than the expected state.

## Measurement

**Field (real users).** `src/lib/web-vitals.ts` subscribes to LCP, INP, CLS and
TTFB and reports each once per page load. `startWebVitals()` runs only from
`startAnalytics()`, i.e. after cookie consent — decliners send nothing and the
`web-vitals` chunk is never downloaded. Data lands in GA as a `web_vitals` event
and in PostHog as a `web_vitals` capture, both carrying `metric_name`,
`metric_value`, `metric_rating`, `metric_id`, `navigation_type`. CLS is sent ×1000
as an integer (0.043 → `43`); the rest are whole milliseconds.

**Lab (CI).** `.github/workflows/lighthouse.yml` builds the prerendered `dist/`
(the same HTML bots see) and runs Lighthouse over **13 URLs**
(`lighthouserc.json:5-18`) on **both** the desktop and mobile configs
(`lighthouserc.mobile.json`), asserts budgets at `warn`, and upserts a
non-blocking PR comment. It is `continue-on-error` — the merge gate is `ci.yml`,
not this. Locally: `npm run build && npx @lhci/cli autorun --config=./lighthouserc.json`.

`"numberOfRuns": 1` (`lighthouserc.json:20`), deliberately, to cap CI runtime —
the workflow's "median" language is about picking a representative run per URL,
not averaging repeats. So a single noisy number is a **signal to re-run**, not a
regression. This note said "3 URLs, desktop preset, 3 runs, median" until
2026-08-08; every part of that was wrong, and the third part is the one that
would make you trust a fluke.

Budgets asserted include `categories:seo ≥ 0.95` alongside the performance ones
in the table above.

## Verifying no regression

Check field data on one URL of each type: a
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

Add it to `ROUTE_OG_IMAGES` in `src/lib/seo/public-routes.ts`, with `alt`. That
is the whole procedure — one edit.

The image sitemap reads `dist/seo-manifest.json`, which the Vite `seoManifestPlugin`
emits from `ROUTE_OG_IMAGES` at build (US-2111), so new cards arrive on their own.

> [!warning] Do NOT mirror it into `functions/_shared/sitemap.ts` (corrected 2026-08-08)
> This note used to call that a mandatory second edit "in lockstep", on the
> reasoning that Pages Functions cannot import from `src/`. True, and irrelevant:
> the manifest is how the value crosses that boundary. The array is now
> `FALLBACK_MARKETING_IMAGES` (`sitemap.ts:720`) and exists only for a
> manifest-fetch failure — its own comment at `sitemap.ts:718` says "Do not add
> new cards here". Following the old step adds a line to a fallback list that is
> **expected** to drift, and teaches the next person that the two must match.

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
seller profiles (`functions/verified/[handle].ts`), the blog
(`functions/blog/[[path]].ts`), author pages (`functions/authors/[[path]].ts:45`)
and garment passports (`functions/passport/[slug].ts:73`). These are the surfaces link-preview bots and
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
  links collapse onto one entry and can't fragment or poison the cache. The flip
  side is a hard rule: **nothing per-visitor may be rendered into these bytes**,
  because the first arriver's copy is served to everyone after them. US-2108 hit
  this with affiliate `?ref=` codes and resolved it by emitting a fixed,
  nonce-stamped script (`functions/_shared/affiliate-capture.ts`) that reads the
  param client-side from the visitor's own URL — the HTML stays identical.
- Stored only when the response is `200` **and** its `Cache-Control` contains
  neither `no-store` nor `private` (`blog-render.ts:255`) — so the blog `preview`
  route (`private, no-store`) and 404/503s pass through untouched. Note the guard
  is a **deny-list, not an allow-list**: it does not require a `public` token, so
  a 200 with no `Cache-Control` at all WOULD be cached. Any new SSR surface must
  set its header explicitly rather than relying on this to fail safe.
- Adds `x-gt-cache: HIT|MISS` so a HIT is verifiable, and stores via `waitUntil()`
  so the first (MISS) response isn't blocked.
- Degrades to a plain render when `caches` is unavailable (local `wrangler`).

**Purge on publish / score-change.** A cached page must not outlive its data.
The existing `lib/cloudflare-purge.ts` plumbing is extended with
`buildCertPurgeFiles()` / `buildSellerPurgeFiles()` and best-effort wrappers
`purgeCertificateCache()` / `purgeSellerProfileCache()` (no-op + no DB hit when
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ZONE_ID` are unset; never throw). Call sites
import **`invalidateCertificate()`**, not `purgeCertificateCache()` directly —
the former also runs `deleteCertImages()` (`lib/cloudflare-purge.ts:122`). Grep
for the wrong name and you will conclude the cert purge is unwired. They evict
the cert SSR page **plus** its OG/badge/slab image renderers (all encode the
score), or the profile SSR page + its OG card. Wired into every write that
changes the data:

| Trigger | Code | Purges |
|---|---|---|
| Dispute resolved with a grade change | `routes/admin-disputes.ts:13` → `invalidateCertificate()` | `/cert/:id` (+ og/badge/slab) |
| Review-queue grade adjustment | `routes/admin-grading.ts:115` → `invalidateCertificate()` | `/cert/:id` (+ og/badge/slab) |
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

> [!warning] This paragraph contradicted the note's own table (corrected 2026-08-08)
> It ended "Cloudflare Image Transformations remain **off** on the zone, which is
> why the flag defaults to off" — while the toggles table above already recorded
> the flag as DONE and verified 2026-08-03. **The flag has been on since US-2333**
> (`.env.production`, `wrangler.toml`). A reader who landed in Corrections got the
> opposite answer from the same document.
>
> Worth naming as a shape: a "Corrections" section is written once, to settle an
> argument, and then never re-read when the thing it settled changes. It ages
> faster than the body it corrects, not slower.

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
