# PRD: Hardened SEO & GEO (Generative Engine Optimization) Program

## Introduction

GradeThread is a client-rendered React SPA on Cloudflare Pages. Today the only
crawler-grade HTML we serve is the **public blog**, which is server-rendered at
the edge by Cloudflare Pages Functions (`functions/blog/[[path]].ts`) reading
from an anonymous edge API (`/api/content/public/*`). Everything else — the
landing page, legal pages, and the public grade **certificates** (`/cert/:id`) —
ships as an empty `<div id="root">` and only paints after JS executes.

That is the central SEO/GEO liability. Googlebot can render JS, but the AI
crawlers that now drive a large and growing share of discovery — **GPTBot /
OAI-SearchBot** (OpenAI), **ClaudeBot** (Anthropic), **PerplexityBot**,
**Google-Extended** (Gemini), **Applebot-Extended** — largely do **not** execute
JavaScript. They see nothing on our highest-intent pages. Certificates are our
single biggest organic opportunity (one indexable, link-worthy, shareable page
per graded garment) and they are currently invisible to search and to AI answer
engines.

This program closes that gap and builds a **self-maintaining SEO machine**: a
single source of truth for indexable routes that automatically drives
prerendering, the sitemap, and instant-indexing (IndexNow) submissions whenever a
page is added or content is published — plus the structured-data, content, and
performance work required to rank in both traditional search and AI search.

## Goals

- **Crawlable HTML for every public surface** (landing, legal, marketing,
  certificates, blog) with no cloaking — identical HTML to humans and bots.
- **Zero-touch sitemap + indexing**: adding a public route or publishing content
  automatically updates the sitemap and pings IndexNow; no hand-edited
  `sitemap.xml`.
- **Win AI search (GEO)**: structured data (Organization, WebSite, SoftwareApplication,
  FAQPage, BreadcrumbList), answer-first content, freshness signals, and
  AI-crawler-friendly `robots.txt` / `llms.txt`.
- **Win traditional search**: canonical + meta hygiene, rich results, internal
  linking, programmatic topical authority pages, and passing Core Web Vitals
  (LCP < 2.5s, INP < 200ms, CLS < 0.1 at p75 — weight increased in the March 2026
  core update).
- **Measure it**: Search Console / Bing Webmaster verification, GSC performance
  ingestion, and an admin SEO health dashboard.

## Non-Goals

- Paid search / SEM, link-building outreach, or social media scheduling (the
  content module already covers authoring/scheduling).
- Internationalization / hreflang (the SEO component should be hreflang-*ready*
  but we ship English-only).
- Replacing the existing blog SSR — we extend the same pattern, we don't rebuild it.

## Current State (what already exists — do not rebuild)

| Capability | Where | Status |
|---|---|---|
| Blog SSR + JSON-LD (Article/Blog/Organization) | `functions/blog/[[path]].ts`, `functions/_shared/blog-render.ts` | ✅ |
| Dynamic `sitemap.xml` (static routes + blog posts + tags) | `functions/sitemap.xml.ts` | ✅ but hand-listed static routes |
| Dynamic `robots.txt` | `functions/robots.txt.ts` | ✅ but no per-AI-UA rules, no `llms.txt` |
| RSS feed | `functions/rss.xml.ts` | ✅ |
| Anonymous public content API | `services/edge-functions/src/routes/content-public.ts` | ✅ |
| Cloudflare cache purge on publish | `services/edge-functions/src/lib/cloudflare-purge.ts`, `content-blog.ts` | ✅ (IndexNow hook point) |
| Client `<SEO>` (react-helmet-async) | `src/components/seo.tsx` | ✅ but no JSON-LD, only client-side |
| Landing FAQ content (visible) | `src/pages/landing.tsx` | ✅ but no FAQPage schema |

## Architecture

### 1. The engine: a single route registry (source of truth)

Create `src/lib/seo/public-routes.ts` — a typed list of every **indexable static
route** with its SEO metadata (path, title, description, `changefreq`, `priority`,
optional JSON-LD descriptor). This single file is consumed by:

1. **Prerender** — the build step renders exactly these routes to static HTML.
2. **Sitemap** — a build step emits `dist/seo-manifest.json`; `functions/sitemap.xml.ts`
   reads it (instead of a hand-listed array) and merges it with blog + certificate URLs.
3. **IndexNow** — deploy-time submission iterates the manifest.
4. **A CI guard test** — fails the build if a router path under a public layout has
   no registry entry (or a registry entry points at a non-existent route). This is
   what makes the sitemap "update itself when we add a page": you *cannot* ship a
   public page without registering it.

Dynamic public collections (blog posts, certificates) are **not** in this static
registry — they enter the sitemap via the edge API, which already knows them.

### 2. Crawlable HTML — two rendering paths, no cloaking

- **Static public pages** (landing, legal, all new marketing/glossary pages):
  **build-time prerender**. After `vite build`, a headless-browser pass crawls the
  local `vite preview` server for every route in the registry and writes the
  fully-rendered HTML (including helmet `<head>` tags and injected JSON-LD) to
  `dist/<route>/index.html`. Cloudflare Pages then serves that static HTML to
  *everyone*; React hydrates on top. No bot detection, no cloaking risk.
  (react-snap-style; pick a maintained lib such as `@prerenderer/rollup-plugin`
  or a small custom Puppeteer script. `vite-react-ssg` is an acceptable alternative
  but is a larger migration of `createBrowserRouter`.)
- **Dynamic public pages** (`/cert/:id`): **edge SSR** via a new Pages Function
  `functions/cert/[id].ts`, mirroring the blog pattern, fed by a new anonymous
  endpoint `/api/content/public/certificates/:id`. Only `is_public` certificates
  are rendered; private ones 404.

### 3. Structured data (JSON-LD) everywhere

- Global: `Organization`, `WebSite` (+ `SearchAction`), `SoftwareApplication` on
  the landing page and in every prerendered page's `<head>`.
- `FAQPage` from the existing landing FAQ data (Note: Google dropped FAQ *rich
  results* in May 2026, but FAQPage schema is still used by AI Mode / answer
  engines to extract and cite Q&A — keep it for GEO).
- `BreadcrumbList` on blog, certificate, and nested marketing pages.
- `HowTo` on `/how-it-works`.
- Certificate: a rich descriptor of the graded garment + grade
  (`Product`/`CreativeWork` with an `aggregateRating`-style grade block) so the
  numeric grade is machine-readable and AI-citable.

A shared `src/lib/seo/json-ld.ts` builds these objects; the prerender + the edge
SSR both serialize them into `<script type="application/ld+json">`.

### 4. Instant indexing — IndexNow

- Generate an IndexNow key; host it at `/<key>.txt` (Cloudflare Pages static file)
  and reference `keyLocation` in submissions.
- Shared submitter `services/edge-functions/src/lib/indexnow.ts` (POST bulk to
  `https://api.indexnow.org/indexnow`).
- Hook it into the existing publish/cache-purge flow in `content-blog.ts` so every
  blog publish/edit/unpublish submits the affected URL(s). Add the same on
  certificate publication.
- Deploy-time GitHub Action submits changed static URLs from the manifest.
- Google's sitemap *ping* endpoint was deprecated (2023); rely on the
  `robots.txt` sitemap reference + Search Console. Bing/Yandex/Naver/Seznam get
  it via IndexNow.

### 5. AI-crawler controls

- Rewrite `functions/robots.txt.ts` with explicit per-UA blocks: **allow** the
  crawlers we want answering with our content (GPTBot, OAI-SearchBot, ChatGPT-User,
  ClaudeBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended,
  Applebot-Extended, Bingbot, Googlebot), keep `/dashboard /admin /auth /api`
  disallowed for all, and reference the sitemap. Optionally throttle/deny
  aggressive non-attributing scrapers (Bytespider, etc.) — make this a config list.
- Generate `/llms.txt` (Markdown index of key pages with one-line descriptions).
  Adoption is still low and unproven for citations, but it is cheap and harmless.

### 6. Performance (Core Web Vitals)

- Report `web-vitals` (LCP/INP/CLS/TTFB) to analytics.
- Kill CLS: explicit `width`/`height` on all images, `font-display: swap` +
  preload Inter, reserve space for the cookie banner.
- LCP: preload the landing hero, prioritize above-the-fold.
- INP: the prerendered-then-hydrated pages already help; keep main-thread work down.
- Add Lighthouse CI as a non-blocking budget check.

### 7. Content & programmatic SEO (topical authority + GEO)

- New evergreen marketing routes (registry-driven, auto-prerendered + sitemapped):
  `/pricing`, `/how-it-works`, `/grading-scale`, `/for-resellers`,
  `/condition-grading` (pillar), `/faq`.
- **Glossary / knowledge hub**: one page per grading tier and factor generated
  from `src/lib/constants.ts` (e.g. `/grading/nwt`, `/grading/excellent`,
  `/grading/fabric-condition`), each with a definition, examples, FAQ, and
  breadcrumb. This is cheap, high-authority, and exactly what AI answer engines
  cite for "what does NWOT mean" style queries.
- Blog GEO upgrades: answer-first intro (first ~200 words answer the query),
  table of contents, FAQ blocks, E-E-A-T author byline, related-posts internal
  linking, surfaced `dateModified` freshness.

### 8. Measurement

- Search Console + Bing Webmaster verification (meta tag via SEO component or DNS).
- GSC Search Analytics API pull into an admin **SEO** dashboard: top queries,
  impressions, clicks, CTR, average position, indexation coverage, plus an
  IndexNow submission log and a schema-validation/broken-link audit.

## Risks & Mitigations

- **Cloaking penalty** — avoided by serving the *same* prerendered HTML to
  everyone (static path) and full SSR (cert path); no UA-based content swapping.
- **Prerender throughput / build time** — prerender only the finite static
  registry; dynamic collections stay edge-SSR. Cache SSR at the edge (already done
  for blog) and purge on publish.
- **Tenant isolation (US-268)** — the new `/cert` and certificate-sitemap
  endpoints are anonymous and MUST hard-filter to public certificates only,
  exactly like `content-public.ts` filters `status='published'`.
- **Stale prerender** — static pages re-prerender on every deploy; that is their
  cadence (they change rarely). Dynamic content is never prerendered.

## Rollout (maps to user stories)

1. **Engine & crawlability** (US-291..US-295): route registry + CI guard,
   prerender pipeline, registry-driven sitemap, certificate edge SSR, AI
   robots.txt + llms.txt.
2. **Indexing automation** (US-296..US-297): IndexNow lib + publish hook,
   deploy-time submission.
3. **Structured data** (US-298..US-301): global schema, FAQ/Breadcrumb/HowTo,
   certificate grade schema, SEO component upgrade.
4. **Content & GEO** (US-302..US-304): marketing pages, glossary hub, blog GEO.
5. **Performance & assets** (US-305..US-307): Core Web Vitals, image pipeline,
   dynamic OG images.
6. **Measurement** (US-308..US-309): GSC/Bing verification + ingestion, SEO
   health admin dashboard.
