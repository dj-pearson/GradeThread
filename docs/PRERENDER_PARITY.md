# Prerender / hydration parity — runbook (US-1669)

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
