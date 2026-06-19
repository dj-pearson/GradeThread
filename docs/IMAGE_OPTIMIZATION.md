# Image Optimization & Discoverability (US-975)

Operator playbook for the image side of Core Web Vitals + image SEO. The **code**
(explicit dimensions, srcset wiring, image sitemap, alt-text) ships ready; the
one remaining step — enabling Cloudflare Transformations — is a **dashboard
toggle**, documented here. See also `docs/SEO_PERFORMANCE.md`.

## What ships in code (no ops step needed)

- **Zero layout shift (CLS).** Every public `<img>` carries explicit `width`/
  `height` (or an `aspect-ratio`) so the browser reserves space before the image
  loads. The reusable `<Image>` component (`src/components/responsive-image.tsx`)
  *requires* `width`/`height` props; the blog SSR (`functions/_shared/blog-render.ts`)
  emits them on the hero + content images.
- **Responsive `srcset`/`sizes` (gated).** `<Image>` and the blog SSR emit a
  Cloudflare Image Resizing `srcset` (+ `sizes`) **only** when
  `VITE_CF_IMAGE_RESIZING="true"`. When the flag is off they ship the plain
  full-size original (always 200s, just unoptimized) — a failed `/cdn-cgi/image/`
  candidate does **not** fall back to `src`, so we never emit the srcset until the
  zone is confirmed on. `width`/`height` are kept either way (CLS protection is
  independent of the flag).
- **Descriptive alt text.** All public/prerendered `<img>` carry meaningful
  `alt`. Blog body images are rewritten through `rewriteContentImages`, which
  guarantees a non-empty `alt` (regression-tested in `src/test/blog-geo.test.ts`).
  Per-route share images carry `alt` in `src/lib/seo/public-routes.ts`
  (`ROUTE_OG_IMAGES`).
- **Image sitemap.** `functions/sitemap-images.xml.ts` serves a Google image
  sitemap listing the public marketing share images + each blog post's hero
  image, grouped under the page they appear on, each with `<image:title>` and
  `<image:caption>`. It is referenced from the `/sitemap.xml` index (when the URL
  count crosses the index threshold) **and** always advertised in `robots.txt`
  via a dedicated `Sitemap:` line, so crawlers discover it regardless.

## Ops step — enable Cloudflare Image Transformations

`/cdn-cgi/image/...` URLs **404 until Transformations is enabled on the zone.**
This is the single human step that turns on the responsive `srcset`.

1. Cloudflare dashboard → the `gradethread.com` zone → **Speed → Optimization →
   Image Optimization → Transformations** → **Enable for this zone**.
2. Set the build/runtime env var **`VITE_CF_IMAGE_RESIZING="true"`** in the
   Cloudflare Pages project (Settings → Environment variables — it is exposed to
   both the Vite build *and* the Pages Functions runtime, so one var flips both
   the React `<Image>` and the blog SSR).
3. Redeploy the frontend (Pages auto-builds on push; trigger a re-deploy if the
   var was added without a new commit).

### Verify it worked

A transformed URL must return **200**, not 404:

```bash
# Should return HTTP/2 200 with an image content-type once Transformations is on.
curl -sI "https://gradethread.com/cdn-cgi/image/width=320,format=auto/logo_primary.png" \
  | head -n 1

# Sanity: the untransformed original is always 200 regardless of the flag.
curl -sI "https://gradethread.com/logo_primary.png" | head -n 1
```

If the first command returns `404`, Transformations is still off (or the var is
not set / not redeployed). The site is not broken in that state — it just serves
full-size originals.

Confirm the responsive markup once enabled: load a marketing page, open
DevTools → Network, and verify the `<img>` requests a resized
`/cdn-cgi/image/width=…` candidate (not the full-size original).

## Verify the image sitemap

```bash
# Valid XML, image namespace present, entries grouped under page <loc>s.
curl -s https://gradethread.com/sitemap-images.xml | head -n 20

# Advertised in robots.txt.
curl -s https://gradethread.com/robots.txt | grep -i sitemap
```

The sitemap is also accepted directly in Google Search Console (Sitemaps →
submit `sitemap-images.xml`), though submitting the `sitemap.xml` index is
sufficient once it lists it.

## Adding a new marketing image

When you add a new marketing route with a distinct share card:

1. Add it to `ROUTE_OG_IMAGES` in `src/lib/seo/public-routes.ts` (with `alt`).
2. Mirror it into `MARKETING_IMAGES` in `functions/_shared/sitemap.ts` (Pages
   Functions can't import from `src/`), with a concise `title` + descriptive
   `caption`.

Blog hero images need no manual step — they flow into the image sitemap from the
`/api/content/public/sitemap.json` endpoint automatically.
