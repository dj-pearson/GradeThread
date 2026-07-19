// Appends the Hardened SEO & GEO program user stories (US-291..US-309) to
// prd.json. Idempotent: re-running skips IDs that already exist. Mirrors the
// existing scripts/update-prd-*.mjs pattern.
//
// Source PRD: tasks/prd-seo-hardening.md
//
// Run: node scripts/update-prd-seo.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRD_PATH = join(__dirname, "..", "prd.json");

const REF = "PRD ref tasks/prd-seo-hardening.md. Hardened SEO & GEO program.";

/** @type {Array<{id:string,title:string,description:string,acceptanceCriteria:string[],priority:number,passes:boolean,notes:string}>} */
const stories = [
  {
    id: "US-291",
    title: "SEO: indexable public-route registry + CI guard (the engine)",
    description:
      "As a developer, I need a single typed source of truth for every indexable static public route and its SEO metadata, so that adding a page automatically flows into prerendering, the sitemap, and IndexNow — and so a page can never ship un-indexed by accident.",
    acceptanceCriteria: [
      "New src/lib/seo/public-routes.ts exports PUBLIC_ROUTES: an array of { path, title, description, changefreq, priority, jsonLdType? } covering all indexable static routes (/, /privacy, /terms, /cookies, /acceptable-use, and any added later)",
      "Helper getRouteMeta(path) returns the registry entry (or undefined) for use by the <SEO> component and prerender step",
      "A build step (vite plugin or postbuild script) emits dist/seo-manifest.json from PUBLIC_ROUTES for consumption by the sitemap Pages Function",
      "Vitest guard test in src/lib/seo/__tests__: every router path rendered under RootLayout that is NOT behind ProtectedRoute/AdminRoute/AuthLayout has a PUBLIC_ROUTES entry, and every PUBLIC_ROUTES path exists in the router — the test fails otherwise",
      "Dashboard/admin/auth/api paths are explicitly excluded from the registry (they must stay noindex)",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 291,
    passes: false,
    notes: `${REF} Foundation story — US-292/293/296 depend on this registry + manifest.`,
  },
  {
    id: "US-292",
    title: "SEO: build-time prerender of static public routes (crawlable HTML, no cloaking)",
    description:
      "As a search/AI crawler that does not execute JavaScript (GPTBot, ClaudeBot, PerplexityBot, etc.), I need fully-rendered HTML for the landing and marketing pages so I can index and cite them, while human visitors still get the hydrated SPA.",
    acceptanceCriteria: [
      "A postbuild prerender step renders every PUBLIC_ROUTES path (US-291) to dist/<route>/index.html with the route's real content, <title>, meta description, canonical, OG tags, and JSON-LD already in the HTML (no JS required to see them)",
      "Implementation uses a headless-browser crawl of the local vite preview server (react-snap-style) or an equivalent maintained Vite prerender plugin; choice documented in a comment",
      "Identical HTML is served to all visitors (no user-agent branching / no cloaking); React hydrates the prerendered markup without a full re-render mismatch warning",
      "react-helmet-async head tags are captured into the prerendered <head>",
      "npm run build still succeeds and the SPA fallback (/* /index.html 200) continues to work for non-prerendered routes",
      "A smoke test asserts dist/index.html contains the landing H1 / hero copy as static text",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 292,
    passes: false,
    notes: `${REF} Depends on US-291. Dynamic public pages (/cert, /blog) use edge SSR instead (US-294, existing blog SSR).`,
  },
  {
    id: "US-293",
    title: "SEO: registry-driven dynamic sitemap with sitemap index",
    description:
      "As a developer, I need the sitemap to build itself from the route registry plus dynamic collections, so I never hand-edit sitemap.xml and new pages appear automatically.",
    acceptanceCriteria: [
      "functions/sitemap.xml.ts reads dist/seo-manifest.json (US-291) for static routes instead of the current hard-coded add() calls",
      "Sitemap merges: static registry routes + published blog posts/tags (existing /api/content/public/sitemap.json) + public certificates (new /api/content/public/certificates.json, US-294 endpoint)",
      "Each <url> includes <lastmod> where known; static public/sitemap.xml is removed so the dynamic Function is authoritative",
      "If total URLs exceed 5,000 the function emits a sitemap index (sitemap-static.xml, sitemap-blog.xml, sitemap-certs.xml) and /sitemap.xml becomes the index",
      "robots.txt sitemap reference still resolves; sitemap validates against the sitemaps.org 0.9 schema",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 293,
    passes: false,
    notes: `${REF} Depends on US-291 (manifest) and US-294 (cert endpoint). Removes the stale hand-listed static routes.`,
  },
  {
    id: "US-294",
    title: "SEO: public certificate edge SSR (crawlable cert pages)",
    description:
      "As a buyer or AI answer engine, I need the public grade certificate at /cert/:id to return fully-rendered HTML with the grade, report, and structured data, so certificates are indexable and citable — they are our highest-volume organic surface.",
    acceptanceCriteria: [
      "New Cloudflare Pages Function functions/cert/[id].ts SSRs /cert/:id mirroring the blog SSR pattern (functions/_shared/blog-render.ts helpers)",
      "New anonymous edge endpoint GET /api/content/public/certificates/:id in content-public.ts returns ONLY public/shareable certificates (hard server-side filter; private/unlisted certs 404 — see US-268 tenant-isolation rules)",
      "New anonymous edge endpoint GET /api/content/public/certificates.json returns {id, updated_at} for all public certificates for the sitemap (US-293), capped + paginated",
      "Rendered HTML includes title, meta description, canonical (https://gradethread.com/cert/:id), OG image, and JSON-LD grade descriptor (US-300)",
      "The SPA /cert/:id route still hydrates for human visitors; cert publication purges the edge cache + pings IndexNow (US-296)",
      "Cross-tenant test: requesting a private certificate id via the public endpoint returns 404, never the data",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 294,
    passes: false,
    notes: `${REF} CRITICAL: anonymous service-role queries — must hard-filter to public certs only (US-268).`,
  },
  {
    id: "US-295",
    title: "SEO: hardened robots.txt for AI + traditional crawlers, plus llms.txt",
    description:
      "As a site owner, I need explicit per-user-agent crawl rules so the AI and search crawlers I want answering with my content are allowed, private surfaces stay blocked, and a curated llms.txt points models at my best pages.",
    acceptanceCriteria: [
      "functions/robots.txt.ts emits explicit Allow rules for Googlebot, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, and Applebot-Extended",
      "All user-agents keep /dashboard/ /admin/ /auth/ /api/ /accept-invite Disallow'd; sitemap reference retained",
      "An exportable BLOCKED_AI_AGENTS config list (default: empty/commented) lets us disallow aggressive non-attributing scrapers (e.g. Bytespider) without code changes",
      "New functions/llms.txt.ts serves a Markdown llms.txt: H1 site description + sectioned links (Product, Grading scale/glossary, Blog, Legal) with one-line descriptions, generated from the route registry + key URLs",
      "robots.txt and llms.txt return text/plain with sane Cache-Control",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 295,
    passes: false,
    notes: `${REF} robots.txt is the real lever; llms.txt is low-cost/unproven but harmless.`,
  },
  {
    id: "US-296",
    title: "SEO: IndexNow instant-indexing on publish",
    description:
      "As a content publisher, I need new and changed URLs submitted to IndexNow the moment they go live, so Bing, Yandex, Naver, and Seznam index them within minutes instead of waiting for a crawl.",
    acceptanceCriteria: [
      "An IndexNow key (32-128 hex chars) is generated; the key file is served at /<key>.txt (Cloudflare Pages static file or Function) returning exactly the key",
      "New services/edge-functions/src/lib/indexnow.ts exposes submitUrls(urls: string[]) that POSTs {host, key, keyLocation, urlList} to https://api.indexnow.org/indexnow (best-effort, never throws into the request path)",
      "content-blog.ts publish/edit/unpublish flow calls submitUrls alongside the existing purgeCloudflareCache (cloudflare-purge.ts) — old + new slug on rename",
      "Certificate publication (US-294) also submits the cert URL",
      "The key is read from an env var (INDEXNOW_KEY) and documented in vault/10-ops/env-reference.md and services/edge-functions/.env.example; submission no-ops cleanly when unset",
      "Unit test mocks fetch and asserts the correct payload shape + that failures are swallowed",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 296,
    passes: false,
    notes: `${REF} Reuse the existing publish hook in content-blog.ts. Google sitemap-ping is deprecated; IndexNow covers Bing/Yandex/Naver/Seznam.`,
  },
  {
    id: "US-297",
    title: "SEO: deploy-time IndexNow submission of static routes",
    description:
      "As a developer, I need the CI/CD deploy to submit changed static URLs to IndexNow after a successful Cloudflare Pages deploy, so marketing/landing page changes are picked up immediately.",
    acceptanceCriteria: [
      "A GitHub Action step (after the Pages deploy) reads dist/seo-manifest.json and submits those absolute URLs to IndexNow via the same endpoint/key as US-296",
      "Submission is gated on the production branch only and skips on previews",
      "Step is non-blocking (deploy success is not failed by an IndexNow error) and logs the response code",
      "INDEXNOW_KEY is wired as a GitHub Actions secret and referenced in the workflow",
      "A scripts/submit-indexnow.mjs helper performs the submission and is unit-testable / runnable locally with a --dry-run flag",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 297,
    passes: false,
    notes: `${REF} Depends on US-291 (manifest) + US-296 (key/endpoint).`,
  },
  {
    id: "US-298",
    title: "SEO: global structured data (Organization, WebSite+SearchAction, SoftwareApplication)",
    description:
      "As an AI answer engine and Google, I need GradeThread's core entity, site search, and product described in JSON-LD so the brand earns a knowledge panel, sitelinks search box, and accurate entity recognition.",
    acceptanceCriteria: [
      "New src/lib/seo/json-ld.ts builds typed JSON-LD objects: organizationLd(), webSiteLd() with a SearchAction, and softwareApplicationLd() (name, applicationCategory, offers/price from constants, aggregateRating placeholder)",
      "The landing page (src/pages/landing.tsx) renders Organization + WebSite + SoftwareApplication JSON-LD via the <SEO> component (US-301)",
      "JSON-LD is present in the prerendered HTML (US-292), not only after hydration",
      "Organization logo, url, and sameAs (social/profile URLs) are populated; values match visible page content (Google policy)",
      "All emitted JSON-LD passes Google Rich Results / schema.org validation (documented manual check in notes or a structural unit test)",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 298,
    passes: false,
    notes: `${REF} The edge SSR (blog/cert) already has an organizationLd helper — keep the two in sync or share constants.`,
  },
  {
    id: "US-299",
    title: "SEO: FAQPage, BreadcrumbList, and HowTo structured data",
    description:
      "As an AI answer engine, I need question/answer pairs, page hierarchy, and step-by-step processes in machine-readable JSON-LD so my answers can extract and cite GradeThread directly.",
    acceptanceCriteria: [
      "faqPageLd(faqs) in json-ld.ts (US-298) generates FAQPage JSON-LD from the existing landing FAQ data; landing emits it (note: Google dropped FAQ rich results May 2026, but keep it for AI Mode / answer engines)",
      "breadcrumbLd(items) generates BreadcrumbList; applied to blog posts, certificate pages, and nested marketing/glossary pages",
      "howToLd(steps) generates HowTo; applied to /how-it-works (US-302)",
      "Schema is emitted in prerendered/SSR HTML and reflects visible on-page content",
      "Structural unit tests validate required fields for each type",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 299,
    passes: false,
    notes: `${REF} Depends on US-298 (json-ld.ts) and US-302 (how-it-works page).`,
  },
  {
    id: "US-300",
    title: "SEO: certificate grade structured data (AI-citable)",
    description:
      "As an AI answer engine, I need the graded garment and its condition grade described in JSON-LD so a query like 'what is GradeThread certificate X' or 'condition grade for <item>' can be answered and cited with the exact numeric grade.",
    acceptanceCriteria: [
      "certificateLd(cert) in json-ld.ts builds a Product/CreativeWork descriptor: name, image(s), brand/category where available, plus the grade expressed as a Rating (ratingValue=grade, bestRating=10, worstRating=1) and the condition tier",
      "The descriptor includes the certificate id, dateCreated/dateModified, and a stable @id of the canonical /cert/:id URL",
      "Both the SSR cert page (US-294) and the hydrated SPA cert page emit this JSON-LD",
      "Only data already visible on the certificate is included (no marked-up hidden fields)",
      "Structural unit test asserts the Rating block and required Product fields",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 300,
    passes: false,
    notes: `${REF} Depends on US-294 + US-298. Certificates are the flagship programmatic SEO surface.`,
  },
  {
    id: "US-301",
    title: "SEO: upgrade the shared <SEO> component (canonical, robots, JSON-LD, article/og)",
    description:
      "As a developer, I need one component that emits complete, correct head metadata (canonical, robots, Open Graph, Twitter, article timestamps, and JSON-LD) for any page, so every public page is consistently optimized.",
    acceptanceCriteria: [
      "src/components/seo.tsx gains props: noindex, jsonLd (object | object[]), ogImage default, ogType, article {publishedTime, modifiedTime, author}, twitterSite, and an optional keywords list",
      "When noindex is true it emits <meta name=robots content='noindex,nofollow'>; otherwise index,follow",
      "JSON-LD passed via prop is serialized into <script type=application/ld+json> (XSS-safe, < escaped)",
      "A sensible default ogImage (brand image) is used when none is provided; canonical defaults to the current pathname under https://gradethread.com when not passed",
      "All existing public pages (landing, legal, certificate) pass jsonLd + canonical through the upgraded component; dashboard/admin pages pass noindex",
      "Unit test renders the component and asserts the emitted tags",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 301,
    passes: false,
    notes: `${REF} Used by US-298/299/300. Keep parity with the edge renderLayout() head tags.`,
  },
  {
    id: "US-302",
    title: "SEO: evergreen marketing pages (pricing, how-it-works, for-resellers, faq)",
    description:
      "As a prospective customer searching for clothing condition grading, I need dedicated, content-rich landing pages so I find GradeThread for high-intent queries and AI engines have substantive pages to cite.",
    acceptanceCriteria: [
      "New public routes + pages: /pricing, /how-it-works, /for-resellers, /faq, /condition-grading (pillar page) — each registered in PUBLIC_ROUTES (US-291) so they auto-prerender + sitemap + IndexNow",
      "Each page has a unique <title>, meta description, H1, answer-first intro (first ~200 words directly answer the page's primary query), H2/H3 hierarchy, and internal links to related pages + signup",
      "/how-it-works emits HowTo JSON-LD (US-299); /faq and /pricing emit FAQPage JSON-LD; all emit BreadcrumbList",
      "Pages reuse the existing landing design system (Tailwind/brand tokens, shadcn) and are responsive",
      "Pricing content is sourced from src/lib/constants.ts plan data so it stays in sync",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 302,
    passes: false,
    notes: `${REF} Depends on US-291/292/298/299. Content can be drafted via the existing content module/knowledge base.`,
  },
  {
    id: "US-303",
    title: "SEO: condition-grading glossary / knowledge hub (programmatic topical authority)",
    description:
      "As someone asking 'what does NWOT mean' or 'what is a fabric condition grade', I need a definitive glossary page per grading tier and factor so GradeThread becomes the cited authority on secondhand clothing condition vocabulary.",
    acceptanceCriteria: [
      "Programmatic public routes generated from src/lib/constants.ts: one page per grade tier (/grading/nwt, /grading/nwot, /grading/excellent, ... ) and per grading factor (/grading/fabric-condition, /grading/structural-integrity, ...)",
      "Each glossary page: definition, the numeric range/weight, what graders look for, examples, a related-terms internal-link block, FAQPage JSON-LD, and BreadcrumbList back to /condition-grading",
      "All glossary routes are added to PUBLIC_ROUTES (or a generated registry extension) so they auto-prerender + sitemap + IndexNow",
      "The pillar page /condition-grading (US-302) links to every glossary page (hub-and-spoke internal linking)",
      "A test asserts every constants tier/factor has a corresponding generated route + registry entry",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 303,
    passes: false,
    notes: `${REF} Depends on US-291/292/299/302. Cheap, durable AI-citation surface keyed off existing constants.`,
  },
  {
    id: "US-304",
    title: "SEO: blog GEO enhancements (answer-first, TOC, FAQ, E-E-A-T, internal links, freshness)",
    description:
      "As an AI answer engine ranking blog content, I need answer-first structure, Q&A blocks, author signals, internal links, and clear freshness so GradeThread blog posts are cited in generative results.",
    acceptanceCriteria: [
      "Blog SSR (functions/blog/[[path]].ts) and the editor support: an answer-first summary/key-takeaways block near the top, an auto-generated table of contents from H2s, optional FAQ blocks rendered as FAQPage JSON-LD, and a visible author byline (E-E-A-T)",
      "Each post renders BreadcrumbList JSON-LD and a related-posts block (by shared tag) for internal linking",
      "dateModified is surfaced visibly ('Updated <date>') and in Article JSON-LD; lastmod already flows to the sitemap",
      "The blog_posts schema/editor gains the fields needed (author, key_takeaways, faqs) via a migration; public API + SSR expose them",
      "Existing posts without the new fields still render correctly (graceful fallback)",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 304,
    passes: false,
    notes: `${REF} Extends the existing content module (00041_content_module.sql, content-blog.ts, blog SSR).`,
  },
  {
    id: "US-305",
    title: "SEO: Core Web Vitals measurement + budget",
    description:
      "As a site owner, I need real-user Core Web Vitals captured and a CI performance budget, so I can keep LCP/INP/CLS in the 'good' band that the March 2026 core update weights more heavily.",
    acceptanceCriteria: [
      "The web-vitals library reports LCP, INP, CLS, and TTFB to analytics (gated by the existing consent flow in src/lib/analytics.ts)",
      "Layout-shift fixes: explicit width/height (or aspect-ratio) on all above-the-fold images, reserved space for the cookie banner, font-display: swap + preload Inter",
      "Landing hero LCP element is preloaded/prioritized",
      "Lighthouse CI runs in GitHub Actions against the prerendered build with budgets (LCP < 2.5s, CLS < 0.1, INP/TBT proxy) as a non-blocking report comment",
      "A short vault/40-growth/seo-performance-images.md records the budgets + where vitals land in analytics",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 305,
    passes: false,
    notes: `${REF} INP < 200ms is the most-failed metric in 2026 — prioritize main-thread/hydration cost.`,
  },
  {
    id: "US-306",
    title: "SEO: image optimization pipeline (responsive, modern formats, lazy)",
    description:
      "As a visitor on a slow connection, I need right-sized, modern-format images so pages load fast (helping LCP/CLS and rankings) without layout shift.",
    acceptanceCriteria: [
      "Public marketing/landing/blog images are served responsively (srcset/sizes) and in AVIF/WebP with fallback",
      "All <img> have explicit width/height (or aspect-ratio) and loading=lazy except the LCP hero (eager + fetchpriority=high)",
      "Blog hero + content images (R2-hosted) get derivative sizes or Cloudflare image resizing; the SSR template emits srcset",
      "A reusable responsive <Image> component (or helper) is used across public pages",
      "Build does not regress bundle size budgets; smoke test asserts srcset present on the landing hero markup",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 306,
    passes: false,
    notes: `${REF} Coordinates with US-305 (CWV). Reuses existing R2 image hosting (r2-client.ts).`,
  },
  {
    id: "US-307",
    title: "SEO: dynamic Open Graph / social share images",
    description:
      "As a user sharing a certificate or blog post, I need an attractive, content-specific social preview image so links earn more clicks (an indirect ranking/engagement signal).",
    acceptanceCriteria: [
      "An edge endpoint (Cloudflare Pages Function or edge service) generates OG images at /og/cert/:id and /og/blog/:slug (1200x630) with brand styling + dynamic title/grade",
      "Implementation uses a lightweight edge-compatible renderer (e.g. satori/resvg or workers OG) — no heavyweight headless browser per request; results are cached at the edge",
      "Certificate SSR (US-294) and blog SSR set og:image / twitter:image to the dynamic URL; static pages keep a high-quality default",
      "Generated images are valid PNGs and pass the Twitter/Facebook card validators (documented manual check)",
      "Failure falls back to the default brand OG image (never a broken image)",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 307,
    passes: false,
    notes: `${REF} Depends on US-294 (cert SSR). Optional-but-recommended; improves CTR from social + AI surfaces.`,
  },
  {
    id: "US-308",
    title: "SEO: Search Console / Bing Webmaster verification + GSC performance ingestion",
    description:
      "As a site owner, I need verified ownership in Google Search Console and Bing Webmaster Tools and the search-performance data pulled into the platform, so I can monitor what's ranking and submit/inspect URLs.",
    acceptanceCriteria: [
      "Site verification supported via a verification meta tag (through the <SEO> component / index.html) and/or a static verification file; values come from env, documented in vault/10-ops/env-reference.md",
      "A scheduled edge job pulls Google Search Console Search Analytics (queries, pages, impressions, clicks, CTR, position) via the GSC API into a new table (migration) using a service account",
      "Indexation coverage summary (indexed vs submitted) is ingested where the API allows",
      "Ingestion is idempotent, rate-limit-aware, and tenant-agnostic (platform-level data, admin-only)",
      "Stored data powers the admin SEO dashboard (US-309)",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 308,
    passes: false,
    notes: `${REF} Bing/Yandex etc. get indexing via IndexNow (US-296); GSC is read-only analytics here.`,
  },
  {
    id: "US-309",
    title: "SEO: admin SEO health dashboard",
    description:
      "As an admin, I need one dashboard showing search performance, indexation, schema health, and crawl issues, so I can run the SEO machine without leaving GradeThread.",
    acceptanceCriteria: [
      "New admin route /admin/seo (AdminRoute-guarded) with a page in src/pages/admin/seo.tsx and a sidebar link",
      "Shows: top GSC queries/pages with impressions/clicks/CTR/position (US-308), Core Web Vitals summary (US-305), and an IndexNow submission log (US-296/297)",
      "Automated audit panel: broken internal links, pages missing title/description/canonical, and JSON-LD structural validation across PUBLIC_ROUTES + recent blog posts/certs",
      "A 'submit to IndexNow' manual action for a pasted URL or a re-submit-all-static button",
      "Audit runs are cached/scheduled (not on every page load) and the page is admin-only / noindex",
      "Tests pass",
      "Typecheck passes",
    ],
    priority: 309,
    passes: false,
    notes: `${REF} Depends on US-305/306/308. Closes the loop: measure → audit → act.`,
  },
];

const prd = JSON.parse(readFileSync(PRD_PATH, "utf8"));
const existing = new Set(prd.userStories.map((s) => s.id));

let added = 0;
for (const story of stories) {
  if (existing.has(story.id)) {
    console.log(`skip  ${story.id} (already present)`);
    continue;
  }
  prd.userStories.push(story);
  existing.add(story.id);
  added += 1;
  console.log(`add   ${story.id} — ${story.title}`);
}

if (added > 0) {
  writeFileSync(PRD_PATH, JSON.stringify(prd, null, 2) + "\n", "utf8");
}
console.log(
  `\nDone. Added ${added} stories. prd.json now has ${prd.userStories.length} user stories.`,
);
