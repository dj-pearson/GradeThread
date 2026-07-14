# SEO Indexability — Diagnosis & Action Plan

_Audit date: 2026-07-14. Scope: why registered public pages aren't getting indexed / earning organic traffic, and the ranked fixes._

## TL;DR

The technical SEO foundation is **excellent and largely complete** — prerendered
HTML, a dynamic sitemap index, canonical discipline, correct `robots` meta,
extensive JSON-LD, and ~15 CI guards. **No page is wrongly `noindex`ed.** So the
problem is almost certainly NOT missing plumbing. It's a combination of:

1. **Diagnosis gap** — nobody has read the GSC _Page indexing_ report to learn the
   *actual* per-page exclusion reason. Everything below #1 is hypothesis until that's done.
2. **JS-only content** on several data-driven pages (crawlers see empty shells).
3. **Config gaps** — GSC/Bing verification tokens and IndexNow key may be unset;
   www→non-www redirect is not in the repo.
4. **New-domain authority** — a large programmatic-page footprint on a low-authority
   domain is the classic "Discovered / Crawled – currently not indexed" profile.

---

## What's already correct (do NOT redo)

- `functions/robots.txt.ts` + `_shared/seo-config.ts`: allows `/`, disallows only
  app/auth/api paths, references both sitemaps, sane per-bot policy.
- `functions/sitemap.xml.ts` + `_shared/sitemap.ts`: self-building sitemap index
  (marketing / grading / blog / certs / sellers / condition / value / durability /
  authors / images) with `lastmod` / `changefreq` / `priority`.
- `scripts/prerender.mjs` + `src/prerender/head-builder.ts`: real SSR HTML, same to
  bots and humans, `<meta robots>` = `index,follow,max-image-preview:large` on every
  registered route, one `<title>`/canonical/description per doc (build-time guard).
- `src/lib/seo/public-routes.ts`: single registry, CI-guarded so you can't ship a
  public route that isn't indexable.
- Canonicals: single base `https://gradethread.com` (non-www), no trailing slash,
  self-canonical SPA fallback, `/c/:id → /cert/:id` 301.
- `public/_redirects`: real 404s (no soft-404). `public/_headers`: no crawl-blocking
  header; SPA shell force-revalidated.
- `functions/blog/*` + `functions/cert/*`: edge-SSR'd with full JSON-LD; photo-less
  certs correctly `noindex`ed as a thin-content guard.

---

## Ranked fixes

### P0 — Diagnose (do first; blocks meaningful prioritization)
- [ ] **Confirm the property is verified in Google Search Console** and the sitemap
      index is submitted and reporting "Success."
- [ ] **Read GSC → Page indexing**. Record the count in each bucket
      (`Discovered – currently not indexed`, `Crawled – currently not indexed`,
      `Duplicate without user-selected canonical`, `Soft 404`, …). Each bucket has a
      DIFFERENT fix; this report is the empirical answer.
- [ ] **URL-inspect 5 representative pages** (home, pricing, a `/grading/` glossary
      term, a blog post, a `/cert/` page). Check "URL is on Google" and compare
      crawled vs rendered HTML. Request indexing on the priority ones.
- [ ] **Verify Cloudflare isn't challenging Googlebot** (Bot Fight Mode / a WAF
      managed rule serving a JS challenge is invisible in code and a classic
      Pages indexing killer). GSC live-inspection "view crawled page" confirms.

### P1 — Config (only you can do; not code-fixable)
- [ ] Set `VITE_GOOGLE_SITE_VERIFICATION` / `VITE_BING_SITE_VERIFICATION` as
      Cloudflare Pages build vars (empty in committed env → no verification tag
      emitted), OR verify via DNS/file.
- [ ] Confirm a **`www → non-www` (or apex) redirect exists at the Cloudflare zone**.
      All canonicals are apex; if `www` also serves content, that's live duplicate
      content. Not present in `public/_redirects` — must be a zone-level rule.
- [ ] Set the **`INDEXNOW_KEY`** secret (Actions + Pages). Without it,
      `.github/workflows/indexnow.yml` skips submission — fast re-crawl is a no-op.
- [ ] Run `node scripts/smoke-functions.mjs` against production to confirm
      `/robots.txt`, `/sitemap.xml`, and a `/cert/` page return real content
      (`wrangler.toml` documents a past incident where Functions silently didn't deploy).

### P2 — Code (I can implement on this branch)
- [ ] **SSR the shell-only data pages.** `createRoot` (not `hydrateRoot`) + client-side
      data fetch means crawlers see an empty shell on: `/verified`, `/leaderboard`,
      `/whats-it-worth`, `/resale-condition-report`, `/state-of-durability`,
      `/condition-index/*`, `/value/*`, `/durability/*`. Seed the primary content at
      prerender (as `/transparency` already does) or edge-SSR it (as `blog`/`cert` do).
      **Highest-impact code fix** — these are the pages most likely judged "thin."
- [ ] **Improve internal linking to the long tail.** Add the pSEO hubs
      (`/grading/scale`, `/grading/glossary`, `/grading/flaws`, `/compare`, `/reselling`,
      `/grading/platform-standards`, the free tools) to the global marketing footer,
      and add a human-readable **HTML sitemap** page. Today the deep programmatic tail
      is reachable only via in-body hub→spoke links + the XML sitemap.
- [ ] **Harden the sitemap against edge failure.** It's built from live edge fetches
      and degrades to just the homepage if the API or `seo-manifest.json` is
      unreachable at request time. Add a monitor/alert on sitemap URL count in GSC.

### P3 — Off-page & content (the likely real bottleneck; no code fixes it)
- [ ] **Authority.** A new domain with ~zero backlinks won't get crawl budget for
      speculative programmatic pages. Earn a handful of real referring domains, brand
      mentions, and digital PR around "the grading standard."
- [ ] **Right-size the indexable surface.** For a young domain, dumping a large
      templated footprint invites site-wide quality suppression. Consider
      `noindex`-ing the thinnest pSEO tiers until authority grows (extend the
      sample-gating already used for value/durability to the other families), and
      focus link equity on the 15–25 best money pages.
- [ ] **Content depth & cadence on the blog** (DB-backed; count only knowable from the
      DB/GSC). Depth + publishing frequency on genuinely useful, intent-matched
      articles is what earns both links and rankings.

---

## Notes

- Static indexable surface = ~40 enumerated routes in `PUBLIC_ROUTES` **plus** several
  generated pSEO families (glossary, reseller-glossary, flipdesk landings, reselling
  guides, flaw library, garment guides, 16 comparisons, 9 platform standards, free
  tools, …). Exact total is only knowable from a build (`dist/seo-manifest.json`) or
  GSC — measure it before deciding what to trim.
- `hreflang` is intentionally omitted (single-locale en site) — not a defect.
- The `noindex` usages that exist (404, blog previews, photo-less certs, trust
  profiles, admin) are all correct.
