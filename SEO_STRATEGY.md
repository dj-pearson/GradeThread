# GradeThread SEO / GEO Authority Strategy

> Synthesized 2026-06-27 from (a) a full codebase SEO/GEO infrastructure audit and
> (b) a deep, adversarially-verified research pass (23 confirmed claims / 31
> sources). Target: rank #1 in Google **and** get cited by AI answer engines
> (ChatGPT, Perplexity, Google AI Overviews/Gemini, Claude) from the **July 1
> 2026** launch. This is the companion to the SEO backlog stories in `prd.json`.

## Thesis: become THE clothing condition grading standard

The single biggest opportunity is **standard-setting**. Research confirms there is
**no established, codified grading standard for secondhand fashion** — the "NWT /
NWOT / Excellent / Very Good / Good tied to value bands" vocabulary that everyone
half-uses is *not* an industry standard (this claim was adversarially **refuted**,
0-3). PSA didn't *follow* a standard; it **published one, branded it "the official
standard," and built proprietary data surfaces that key off the grade** — and that
is why Google and AI engines treat PSA as the canonical source. GradeThread should
do exactly this for clothing. We are not competing on "another grading opinion";
we are publishing **the** standard and the **system of record**.

### The PSA playbook → GradeThread map (verified)

| PSA moat element | Evidence | GradeThread equivalent | Our status |
|---|---|---|---|
| **Codified standard** — numeric 1–10, named tiers, *exact measurable tolerances* per grade, enumerated objective factors + open disclosure of the subjective part | psacard.com/gradingstandards ("Gem Mint 10 … 55/45 front, 75/25 reverse"; "a large part … objective … the other … subjective") | Publish exact per-**tier** definitions **and** per-**factor** tolerances for the 1.0–10.0 scale; document the 5 weighted factors (Fabric 30 / Structural 25 / Cosmetic 20 / Functional 15 / Odor 10) with the same factor-by-factor transparency | `/condition-grading` + `/grading-standard` + 12-spoke glossary exist; **need exact tolerances + "this is THE standard" framing** |
| **Explicit standard-setting claim** — "PSA grading standards have truly become the official standard" | psacard.com/gradingstandards | Assert & document GradeThread AS the clothing condition standard (market-descriptive, like PSA — not a regulatory claim) | **Missing the explicit framing** |
| **Population Report** — "Official Record of all Gradings", exact per-grade counts, daily | psacard.com/Pop | **Condition Index / registry** — aggregate grade distributions + value-by-grade as the canonical record | `/condition-index` (Dataset) exists; **strengthen as "the record"** |
| **Auction Prices Realized** — 5M+ eBay/Goldin results, grade = the price-lookup key | psacard.com/auctionprices | Tie **graded condition → realized resale comps** via FlipDesk; "what does an Excellent (8) [item] sell for" | Condition Index has comps; **surface grade→price prominently** |
| **Cert verification** | psacard.com/cert | Shareable, verifiable certificate + `/verify` | **Done** (`/cert/:id`, `/verify`) |
| **Marketplace tailwind** — PSA took off with eBay (legitimacy for low-res listing photos) | Wikipedia/SCD | Tie grading to the **eBay reseller workflow (FlipDesk)** — same legitimacy play | **FlipDesk has zero public SEO surface — biggest gap** |

## What the research changed (myths to avoid)

- **Google ignores llms.txt and AI-specific markup**, and there is **no special schema** for its generative features — "optimizing for generative AI search … is **still SEO**" (developers.google.com/search/docs/fundamentals/ai-optimization-guide, updated 2026-06-15). → Don't over-invest in llms.txt *for Google*. **Keep our llms.txt** anyway: it's low-cost and **non-Google engines (Perplexity/ChatGPT/Claude) may consume it** (scope caveat is Google-only).
- **FAQ & HowTo rich results are deprecated** in Google. → Keep `FAQPage`/`HowTo` JSON-LD (AI engines still extract Q&A; it's cheap) but **don't expect rich snippets** from them.
- **Structured data is NOT required for AI citation**, but **remains valuable** for SEO/rich results and entity definition. `DefinedTermSet`/`DefinedTerm` is the **correct, canonical** type for a grading standard — emit it well.
- **Most non-Google AI crawlers do NOT run JavaScript** (Vercel/Search Engine Land: GPTBot 569M + Claude 370M requests fetch JS but don't execute it). A client-rendered SPA is **invisible** to ChatGPT/Claude even if it ranks in Google. → **SSR/prerendered HTML is the #1 technical requirement** for AI citation. Gemini is the exception (uses Googlebot rendering).
- **Unique, non-commodity expert content** (original data, tested methodology, first-party expertise) is the **highest long-run lever** for AI presence — Google says it "will likely influence your presence in generative AI search … more than any other suggestion." Our **Condition Index aggregates + transparency report + the published standard** are exactly this; generic "how to sell clothes" listicles are not.

## Current state (from the codebase audit)

**Mature and well-architected** — this is *extend-and-activate*, not greenfield:
- `src/lib/seo/public-routes.ts` (38 routes) → prerender (`scripts/prerender.mjs`, `src/prerender/head-builder.ts`) with SPA↔SSR JSON-LD parity.
- `src/lib/seo/json-ld.ts`: Organization, WebSite, SoftwareApplication, FAQPage, Article, HowTo, AboutPage, BreadcrumbList, Person/ProfilePage, **DefinedTermSet/DefinedTerm**, certificate Product+Review, passport, **Dataset** (resale + transparency).
- Dynamic SSR Pages Functions: `blog`, `cert`, `condition-index`, `authors`, `verified`, OG images; AI-crawler-aware `robots.txt`; registry-driven `llms.txt`; 7-section sitemaps; RSS.
- 12-spoke grading glossary (`src/lib/seo/glossary.ts`), 5 cornerstone pillars, author/E-E-A-T system.

**Gaps (= this strategy's backlog):**
1. **FlipDesk: zero public SEO surface** (highest-value gap; the eBay-management highlight).
2. **No exact per-tier/per-factor tolerances** on the standard pages (the PSA-grade citability lever).
3. **No explicit "we are the standard" entity framing**.
4. **Client-rendered data on key pages** (e.g. `/transparency`, parts of condition-index load data via client JS) → **invisible to AI crawlers**.
5. **No keyword-target registry**; copy is narrative not keyword-mapped.
6. **No marketplace-specific guides** (eBay/Poshmark how-tos = high-intent long-tail tying grading + FlipDesk).
7. **IndexNow + GSC built-but-off** (env-gated; IndexNow not auto-wired to publish/deploy).

## Prioritized roadmap (impact × effort)

### P0 — the authority moat (do before launch)
1. **Codify the standard with exact tolerances + "the standard" framing.** Add per-tier measurable definitions and per-factor tolerances to `/grading-standard` + `/condition-grading`; assert GradeThread as the clothing condition standard (market-descriptive). Strengthen the `DefinedTermSet` + add a `Dataset`/`TechArticle` "spec" entity. *(High impact, medium effort — content + existing schema.)*
2. **SSR/crawlability hardening for AI.** Audit that the grading standard, condition-index data, transparency figures, and certificates render their **key facts in server HTML** (prerender or Pages-Function SSR), not client-only. Fix any client-only data surfaces. *(Highest technical impact for AI citation; medium effort.)*
3. **FlipDesk marketing/SEO surface.** New `/flipdesk` (+ `/ebay-reseller-tools` angle) with `SoftwareApplication` schema, keyword-mapped copy (crosslisting, repricing, comps, inventory, reconciliation), tying grading → eBay resale. Register in PUBLIC_ROUTES + prerender + sitemap. *(High impact, the explicit ask; medium effort.)*

### P1 — content depth + system-of-record
4. **Condition Index as "the Population Report."** Frame + strengthen `/condition-index` as the canonical record of clothing condition→value; surface grade→realized-price prominently; ensure SSR.
5. **Marketplace guides** (start with eBay): "how to sell used clothes on eBay", "eBay condition for used clothes", cross-listing — each tying the grade + FlipDesk. Non-commodity (use our data), Q&A/answer-capsule formatted.
6. **Keyword-target registry** — encode primary/secondary/question keywords per route (intent + cluster) so copy and new content are keyword-mapped, not narrative.
7. **GEO content formatting pass** — answer-capsule (40–60 word) openings on key pages; Q&A FAQ pairs; entity `sameAs` (Wikidata/LinkedIn/Crunchbase) on Organization.

### P2 — activation + ops (some need human/ops creds)
8. **IndexNow automation** — host `/<key>.txt`, auto-submit on publish + deploy-time bulk submit. *(Needs `INDEXNOW_KEY`.)*
9. **GSC activation** — configure service-account env to flow Search Console data into the admin dashboard. *(Needs `GSC_*` creds — ops.)*
10. **Comparison / alternative-to content** (FlipDesk vs Vendoo / List Perfectly / RepricerExpress) — **verify current competitor pricing first** (research flagged inaccurate blog figures).

## Open questions (flagged by the research; resolve before over-investing)
- Real keyword volume/difficulty for the grading + reseller clusters (research was thin here — validate with GSC/keyword tools post-launch).
- Whether Perplexity/ChatGPT/Claude actually benefit from llms.txt + DefinedTermSet in 2026 (Google's position is documented; theirs isn't).
- Competitor pricing/features for defensible comparison content.
- The thin-content line for a programmatic condition-index/registry (PSA-style data pages vs scaled-content-abuse).
- Re-verify Google's GEO guidance right before launch (it changes frequently; the llms.txt clarification landed 2026-06-15).

## Sources (primary)
PSA: psacard.com/{gradingstandards, Pop, auctionprices, cert}. Google: developers.google.com/search/docs/{fundamentals/ai-optimization-guide, appearance/ai-features, crawling-indexing/javascript/javascript-seo-basics}. Schema: schema.org/{DefinedTermSet, inDefinedTermSet}. JS/AI crawlers: searchengineland.com/no-javascript-fallbacks-474605.
