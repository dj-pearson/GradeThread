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
