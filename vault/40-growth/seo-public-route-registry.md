---
title: SEO — the public route registry and its wiring points
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/seo/public-routes.ts
  - src/prerender/entry-server.tsx
  - src/prerender/head-builder.ts
  - src/routes/index.tsx
reviewed: 2026-07-18
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
4. `src/lib/seo/public-routes.ts` — add to `PUBLIC_ROUTES`, including `lastmod`.
5. `src/prerender/entry-server.tsx`.
6. `src/prerender/head-builder.ts` — for `/grading/*` routes, **before** the
   glossary handler, or the glossary catch-all swallows it.
7. `src/routes/index.tsx` — **before** any dynamic `:slug` route, for the same reason.

A CI guard test and the prerender sync-guard fail if 4 and 5 disagree. They do
**not** catch ordering mistakes in 6 and 7 — those surface as a page that renders
in the SPA but prerenders as the wrong template.

## Metadata budget

Enforced by test (US-435):

- **Title ≤ 60 characters**, including the `" | GradeThread"` suffix.
- **Description 70–160 characters.**

Run both `vitest src/lib/seo` and `vitest src/prerender` — they cover different
halves of this and passing one proves little about the other.

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
