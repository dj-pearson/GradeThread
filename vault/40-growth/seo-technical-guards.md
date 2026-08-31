---
title: SEO technical guards — prerender parity and JSON-LD lint
type: contract
status: current
source_of_truth: code
code_refs:
  - src/prerender/head-builder.ts
  - src/prerender/entry-server.tsx
  - src/lib/seo/json-ld.ts
reviewed: 2026-08-31
tags: [seo, prerender, ci, contract]
summary: What CI enforces about the HTML crawlers actually receive, and how to read each failure.
---
# Prerender / hydration parity — runbook (US-1669)

> **Re-reviewed 2026-08-31.** Drift flagged `src/prerender/entry-server.tsx` for US-9033, which adds
> `/tools/rn-lookup` to the prerender map. That is the guard in this note doing
> its job rather than a change to it: the sync guard is what required the entry.
> The new `/rn/:number` family is edge-SSR'd like `/cert` and `/style`, so it
> sits outside the prerender registry by design.

Bots (Googlebot, and JS-less LLM crawlers like GPTBot/ClaudeBot/PerplexityBot)
fetch the **static `dist/*.html`** we prerender — the exact bytes Cloudflare
serves before any JavaScript runs. Humans get the same bytes, then the SPA mounts
over them. "Parity" means: **what the bot reads already contains the full content
humans eventually see** — the title, canonical, article text, and (critically)
the grade table are in the initial byte-stream, not injected after hydration.

Prerendered SPAs drift silently. This is the guard against that.

## What enforces it

- **`src/prerender/__tests__/crawl-parity.test.ts`** audits ≥10 representative
  URLs from the built `dist/`: exactly one `<title>` + one `rel=canonical`, a
  populated `#root` (not an empty shell), no `<meta http-equiv=refresh>`, and
  route-specific body content present in the raw HTML.
- **`scripts/prerender.mjs` → `validateHeadIntegrity()`** already fails the build
  if any page has ≠1 `<title>`/canonical or leaks head tags into `<body>`.
- **`src/prerender/__tests__/jsonld-parity.test.tsx`** pins the prerendered
  JSON-LD equal to what the live `<SEO>` component emits.

CI runs `npm run build` before the test job, so drift fails the build.

## When the audit fails

**"`#root` is an empty SPA shell — content is hydrated in, not prerendered"**
The page renders its content only after mount (e.g. behind a `useEffect`, a data
fetch, or an auth check). Fix: render the crawlable content synchronously in the
page component so `renderToString` (via `src/prerender/entry-server.tsx`) emits
it. Data-dependent numbers can still load client-side — but the surrounding
copy, headings, and tables must render server-side. See `/transparency` (live
figures hydrate, methodology + Dataset JSON-LD are static) as the pattern.

**"`<needle>` missing from the prerendered HTML (hydration drift?)"**
Content a human sees isn't in the static HTML. Usually the component gated it on
a browser-only condition. Move it above that gate, or provide an SSR-safe
fallback. If the copy legitimately changed, update the `must` needle.

**"expected exactly 1 `<title>` / rel=canonical"**
Something injected a second one. The `<SEO>` component's Helmet tags are stripped
from the SSR body by `stripHeadTagsFromBody()`; the canonical head is built by
`head-builder.ts`. A duplicate means new markup emitted a raw `<title>`/canonical
in the body — remove it and let `head-builder` own the head.

**"a `<meta http-equiv=refresh>` would redirect crawlers"**
Never prerender a client-side redirect. Use a real HTTP 301/302 (`_redirects`)
or a router `<Navigate>` that does NOT render a meta-refresh into the static HTML.

## Adding a new public page to the audit

New indexable pages are covered by the per-route `<title>` check in
`prerender.test.ts` automatically. Add an entry to `AUDIT` in
`crawl-parity.test.ts` with a couple of `must` strings whenever the page carries
content that MUST be crawlable (a table, a definition, a pricing grid) — that's
the content most prone to being hydrated in by mistake.

---

## Absorbed: JSON-LD schema lint (`docs/STRUCTURED_DATA_LINT.md`)

Both halves of this note guard the same thing — the HTML a crawler actually
receives. Prerender parity proves the markup exists; the JSON-LD lint proves it
is well-formed. They fail in different tests but for the same reason, so they
live together.

Route wiring is NOT restated here — see [[seo-public-route-registry]].

pSEO templates emit JSON-LD at scale (glossary DefinedTerms, garment guides,
certificates). One broken template = broken markup on hundreds of pages. This
guard validates the schema.org JSON-LD our builders emit and **fails CI** on any
violation.

## What runs

- **`src/lib/seo/jsonld-lint.ts`** — the linter. `lintJsonLdNode(node)` returns
  human-readable violations; `lintJsonLd(nodes)` lints an array (one route's
  structured data). It checks: a valid `@context`/`@type`, no `undefined` or
  non-finite numbers leaking through, and per-`@type` required properties —
  including the Product `itemCondition` (a real `OfferItemCondition`) +
  `additionalProperty` PropertyValue + bounded Rating shape the certificates use.
- **`src/lib/seo/__tests__/jsonld-schema-lint.test.ts`** — runs the linter over
  **every registered route's** JSON-LD (via `jsonLdForRoute`) plus the dynamic
  certificate + passport Product nodes, asserts zero violations, asserts the AC's
  required types are actually covered, and includes negative controls so the
  linter can't silently become a no-op.

CI runs the vitest suite before the build/deploy gate, so a broken node blocks
the release.

## When it fails

The message is `[<@type>] <what's wrong>`, e.g.
`[Product] itemCondition "https://schema.org/BananaCondition" is not a schema.org
OfferItemCondition` or `[Article] missing required property "datePublished"`.
Fix the emitting builder in `src/lib/seo/json-ld.ts` or the page's builder in
`src/pages/marketing/marketing-jsonld.ts` — don't loosen the linter to make a
real gap pass.

## Adding a new @type

1. Add a checker to `TYPE_CHECKERS` in `jsonld-lint.ts` (use `requireKeys(...)`
   for required props; add value-shape checks like `checkProduct` does when a
   property has structure that matters).
2. If the new type is emitted on a route, the route iteration in the test already
   covers it. If it's a dynamic node (like cert/passport), add a fixture case to
   the test.
3. If it's one of the AC's headline types, add it to the "covers the AC's
   required schema types" assertion so coverage is enforced.

## Scope

This is a **targeted** guardrail for the node types GradeThread actually emits,
not a full schema.org validator. It catches the failure modes that bite at pSEO
scale: missing required props, empty/undefined values, wrong enum URLs, and
malformed Product/Rating markup. For a one-off external audit, paste a rendered
page into Google's Rich Results Test.

## Related

- [[seo-public-route-registry]] — the canonical wiring steps; do not restate them here
- [[seo-performance-images]] — the other half of what crawlers experience
- [[seo-indexability]] — these guards pass while pages still go unindexed
- [[INDEX]]
