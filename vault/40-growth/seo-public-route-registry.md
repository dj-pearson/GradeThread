---
title: SEO — the public route registry and its wiring points
aliases: [PUBLIC_ROUTES, add a public page]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/seo/public-routes.ts
  - src/prerender/entry-server.tsx
  - src/prerender/head-builder.ts
  - src/routes/index.tsx
reviewed: 2026-08-08
tags: [seo, prerender, routing]
summary: A new indexable page must be registered in several places in lockstep; CI guards catch some omissions but not all.
---

# SEO — the public route registry

`PUBLIC_ROUTES` in `src/lib/seo/public-routes.ts` is the registry of indexable
routes. `dist/seo-manifest.json` is emitted from it by a Vite plugin, and
`scripts/prerender.mjs` renders the static public pages at build time.

## Adding a public static page

Registration is **not** a single edit. A new page must be wired in lockstep:

1. The page's data module.
2. The page component itself.
3. Marketing JSON-LD, where applicable.
4. `src/lib/seo/public-routes.ts` — **two places, not one.** Add the entry to
   `PUBLIC_ROUTES`, and add the route's date to `ROUTE_LAST_MODIFIED` beside it.
   `PublicRoute` has no `lastmod` field: the dates live in a separate map so an
   unchanged route keeps the same `<lastmod>` every deploy (US-429). Omitting the
   date is not an error — the route silently falls back to
   `DEFAULT_LAST_MODIFIED`, which is a 2026-06-01 that will be wrong on the day
   the page ships.
5. `src/prerender/entry-server.tsx` — **two maps, not one.** `PAGES` maps the
   path to its component; `ROUTE_PAGE_MODULES` maps it to the page module so the
   right chunk is preloaded. Routes that share a page module (glossary, guides,
   comparisons, competitor alternatives) all point at that shared module. Its
   own guard fails the prerender with `ROUTE_PAGE_MODULES out of sync with
   PAGES` — this is the point most often missed, because adding to `PAGES` feels
   like finishing the step.
6. `src/prerender/head-builder.ts` — for `/grading/*` routes, **before** the
   glossary handler, or the glossary catch-all swallows it. `/reselling/*` has
   the same hazard against the reselling-guide lookup.
7. `src/routes/index.tsx` — **before** any dynamic `:slug` route, for the same reason.
8. `ROUTE_OG_IMAGES` (same file as 4) — **only** if the page gets its own
   1200x630 share card. Optional; routes without an entry fall back to the
   site-wide `/og-image.png`.

A CI guard test and the prerender sync-guard fail if 4 and 5 disagree. They do
**not** catch ordering mistakes in 6 and 7 — those surface as a page that renders
in the SPA but prerenders as the wrong template.

The description is written **twice** — in the data module's route generator and
in the page's `MarketingLayout` prop — and they must match for SSR/SPA parity.
Fixing an over-budget description in one place only is the usual way the test
stays red after you "fixed" it.

> [!note] Step 8 now has a second consumer (US-2111, 2026-07-19)
> `ROUTE_OG_IMAGES` used to feed only the `og:image` tag. The Vite manifest
> plugin now also emits each entry into `dist/seo-manifest.json`, and
> `functions/_shared/sitemap.ts` builds the **image sitemap** from that. So
> adding a share card reaches Google's image index automatically — and, more to
> the point, you no longer edit a second hand-synced list to make that happen.
> The `alt` text is reused verbatim as the image caption, which is why it should
> read as a description rather than a label.

> [!note] The admin-subtree split does not affect this contract (US-2112)
> `src/routes/index.tsx` handed its `/admin/*` subtree to
> `src/routes/admin-routes.tsx` and its `lazy()` helper to `src/routes/lazy.tsx`.
> No indexable route moved — `PUBLIC_ROUTES` contains zero `/admin` paths — so
> steps 4-8 are unchanged. Recorded because the file named in step 7 shrank by
> 235 lines, which looks like it should matter and does not.

## Metadata budget

Enforced by test (US-435):

- **Title ≤ 60 characters**, including the `" | GradeThread"` suffix.
- **Description 70–160 characters.**

Run both `vitest src/lib/seo` and `vitest src/prerender` — they cover different
halves of this and passing one proves little about the other. The budget test
lives under `src/lib/seo/__tests__/`, so a `src/prerender` run alone is green
while the title is 17 characters over.

`public-routes.test.ts` asserts every registered route exists in the router. A
concrete indexable path served by a **dynamic** route needs a `startsWith("/x/")`
clause there, or it reads as unrouted.

Verify order that actually works, since two of these depend on the one before:

```
npx tsc -b → eslint <files> → vitest run src/lib/seo
  → npm run build   (regenerates dist)
  → vitest run src/prerender   (dist-dependent — meaningless before the build)
```

## Judging the build

`npm run build` is `tsc -b && vite build && node scripts/prerender.mjs`. A
prerender failure calls `fail()` → `process.exit(1)`, so it **does** fail the
build (verified 2026-08-01; an older note claimed otherwise, see below).

But a green build still does not prove the pages are right, because the
prerender's steps are deliberately split:

- **Fatal** — a render error, or either sync guard.
- **Non-fatal by design** — every build-time data seed (transparency figures,
  data-report aggregates). A failed fetch logs a warning and renders the
  **pre-seed placeholders**. The build stays green and ships a page with
  placeholder numbers on it.

So read the output, not just the status:

- `[prerender] wrote N static page(s)` — and N should be what you expect.
- The new route's `dist/<path>.html` exists and contains real body text plus
  whatever JSON-LD it should carry.
- No `seed fetch failed … rendering placeholders` lines for a page whose whole
  point is live figures.

**Tests that read `dist/` are stale-build detectors.** `src/prerender/__tests__`
passes against the *previous* build's output, so run `npm run build` before
trusting it. `jsonld-parity.test.tsx` is the companion guard: it fails when a
route declares a `jsonLdType` that `jsonLdForRoute()` does not emit.

> [!note] Correction to an earlier claim (2026-08-01)
> A memory recorded that `npm run build` "exits 0 even when the prerender step
> fails". That is not true of the current script — the top-level catch calls
> `fail()`, which exits 1, and `&&` propagates it. The habit it produced is still
> right for a different reason (the non-fatal seeds above), but the stated
> mechanism was wrong, and a wrong mechanism sends the next reader looking for a
> bug that is not there.

## The Helmet trap

`react-helmet-async` v3 renders **no** server-side head and injects **no**
client-side `<script>`. Structured data therefore has two independent paths:

- `<SEO jsonLd={...}>` injects JSON-LD via `useEffect` for the live SPA.
- The prerenderer builds the crawlable `<head>` from the registry and
  `src/lib/seo/json-ld.ts`, and strips Helmet tags that leak into the SSR body.

**Adding structured data means doing both** — `<SEO jsonLd>` *and* mirroring it in
`head-builder.ts`'s `jsonLdForRoute()`. Doing only the first means crawlers never
see it.

Do not add markup for data that does not exist — no `SearchAction` or
`aggregateRating` placeholders. Keep the `index.html` prerender markers
(`prerender:head:start/end`, `<!--prerender:body-->`) intact.

## Related

- [[INDEX]]
- The wider SEO corpus consolidates here in US-2054.
