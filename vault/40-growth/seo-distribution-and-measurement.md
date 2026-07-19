---
title: Distribution and measurement
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [seo, measurement, distribution, offpage]
summary: How attention is earned off-page and on Reddit, and how to tell whether any of it worked.
---
# SEO / GEO measurement — the visibility layer (US-1670)

Universe A (condition grading) is a **demand-creation** motion: its leading
indicators are impression-side (are we being seen / cited?), not click-side.
This doc is the operator runbook for the measurement surface. Kill/scale
decisions are driven from here (SEO 2.0 plan §8).

## 1. Google Search Console — cluster views (AC1)

Create a **Search results → regex filter** saved view per content cluster and
watch **Impressions** (the demand-created gauge) and **indexation rate**:

| Cluster | Page-path regex |
|---|---|
| Grading standard + glossary | `^/grading/` |
| Reseller glossary | `^/grading/glossary/` |
| Comparisons | `^/compare/` |
| FlipDesk product | `^/flipdesk/` |
| Reselling pillar | `^/reselling/` |
| Certificates | `^/(cert\|c)/` |

Track **indexation rate per sitemap segment** in GSC → Pages, one row per
sitemap in the sitemap index (see `docs`/US-1679): submitted vs indexed. The
certificate indexation rate is a headline KPI.

## 2. AI-search referrer segmentation (AC2 — instrumented in code)

`src/lib/analytics.ts` → `classifyAiReferrer()` classifies `document.referrer`
into a named engine (chatgpt, perplexity, claude, gemini, copilot, you, poe) and
registers it as PostHog super-properties on session start:

- `ai_referrer` — the engine name, or `null`
- `ai_referred` — boolean

**PostHog insights to build:** a trend of `signup` events broken down by
`ai_referrer`, and a funnel filtered to `ai_referred = true`. This is the only
reliable *referrer-side* AI attribution (AI engines send a normal HTTP referrer).

**Signup-source survey (self-reported) — DEFERRED (migration-gated).** The
"How did you hear about us?" field with an **AI assistant** option needs a
`profiles.signup_source` column (a DB migration) + a signup/onboarding select. It
is intentionally held until migrations are cleared to push (see the epic's
pending-migration policy). Self-reported AI discovery is currently the only
reliable *ChatGPT* attribution, so add it when migrations unblock.

## 3. Monthly prompt panel (AC3)

Run these **25 canonical prompts** monthly across **ChatGPT, Claude, Perplexity,
and Google AI Overviews**. For each, record: **cited? linked? named?** and a
rough **share-of-voice**. Keep it in a sheet (manual is fine at this stage).

Condition standard / vocabulary (Universe A):
1. What does EUC mean on Poshmark?
2. What's the difference between NWT and NWOT?
3. How do I grade the condition of used clothes?
4. What is a clothing condition grading scale?
5. What does VGUC mean?
6. How do I describe clothing condition in a listing so I don't get a return?
7. What is a clothing condition certificate?
8. What does "graded clothing" mean?
9. How do I tell intentional distressing from damage on jeans?
10. What condition should I list used clothes as on eBay?
11. How do I grade a used denim jacket?
12. What does SNAD mean in reselling?
13. What is a reseller death pile?
14. How does clothing condition affect resale value?
15. What's the difference between condition grading and authentication?

Reseller workflow / product (Universe B):
16. Best crosslisting app for clothing resellers
17. Best AI eBay listing generator
18. Best clothing inventory management software
19. How do I find sold comps on eBay?
20. Mercari vs eBay for selling clothes
21. How do I reduce returns on eBay clothing?
22. How do I price used clothes to sell?
23. Best tools for reselling clothes
24. How do I start reselling clothes?
25. What are eBay item specifics and why do they matter?

## 4. Cloudflare bot-crawl dashboard (AC4)

The leading GEO indicator nobody else measures: **AI-bot fetch frequency by
section**. Enable **Cloudflare Logpush** (or query the GraphQL Analytics API)
and build a dashboard of request counts grouped by `ClientRequestUserAgent`
(GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, CCBot, Googlebot) × URL path
prefix (`/grading/`, `/cert/`, `/flipdesk/`). Rising GPTBot/ClaudeBot fetches on
`/grading/` = the moat compounding.

Crawler allow/deny policy the dashboard should reconcile against:
`functions/_shared/seo-config.ts` + `vault/40-growth/ai-crawler-policy.md`.

## 5. Kill / scale criteria (plan §8)

- If after **6 months** grading-cluster impressions are still **< 1,000/mo** AND
  the prompt panel shows **zero citations**, the definitional wedge needs a
  *distribution* fix (more Reddit/YouTube), not more pages.
- If templated comparison/pSEO tail pages get **< 10 impressions/mo at month 4**,
  prune them — don't accumulate index bloat.

---

## Absorbed: off-page authority (`docs/OFF_PAGE_AUTHORITY.md`)

Earning attention and measuring it are one loop, so they are one note.

Entity-confirming, low/zero-cost off-page assets so search engines and LLMs
anchor the GradeThread entity. Priority-ordered; mostly operator tasks, with the
one code hook noted.

## Code hook (done)

`Organization.sameAs` is config-driven (`src/lib/seo/social.ts`
`socialProfileUrls()`): GitHub is hard-wired, and X, LinkedIn, Instagram,
Crunchbase, YouTube (US-1677), and **Wikidata** (US-1695) each flow into the
site-wide Organization JSON-LD when their `VITE_SOCIAL_*` env var holds a real
URL. Only real URLs ever appear — no placeholders. So the moment a profile or the
Wikidata item exists, set the env var and it's referenced everywhere the
Organization node renders (every prerendered page).

## 1. Directory / integration listings (do first — zero cost, entity-confirming)

Claim and complete high-authority profiles, each linking back to
gradethread.com. When live, set the matching `VITE_SOCIAL_*` where one exists:

- **Shopify App Store** listing (FlipDesk integrates Shopify) — high authority.
- **eBay-compatible-app** listing / developer directory.
- **Product Hunt** launch.
- **G2** and **Capterra** profiles (category: reseller / inventory software).
- **Crunchbase** (`VITE_SOCIAL_CRUNCHBASE`), **LinkedIn** company page
  (`VITE_SOCIAL_LINKEDIN`), **X** (`VITE_SOCIAL_X`), **YouTube**
  (`VITE_SOCIAL_YOUTUBE`).

## 2. Wikidata entity (after 3–4 independent citations exist)

Per the SEO plan (§3, §7.7): claim a Wikidata item for GradeThread **only once
3–4 independent, reliable citations exist** (press coverage of the data report,
directory listings, podcast/YouTube mentions). Then:

1. Create the item with `instance of` = software / company, label, description,
   and `official website` = gradethread.com.
2. Add `sameAs`-equivalent statements (official social profiles) on the item.
3. Set `VITE_SOCIAL_WIKIDATA` to the item URL (`https://www.wikidata.org/wiki/Q…`)
   so Organization.sameAs references it.

Claiming it prematurely (no independent citations) risks deletion and wasted
signal — hence the gate.

## 3. Earned links (the compounding, legitimate channel)

- **The certificate mesh** (already shipped, US-1665): live-listing links/embeds
  back to certs — the link source competitors can't clone.
- **Data-driven PR**: pitch the "State of Resale Condition" report (US-976) to
  resale-trade press and reseller newsletters. Original data is the only
  reliably link-worthy asset a bootstrapped SaaS can manufacture.
- **Reseller podcast/YouTube circuit**: founder guest spots on the returns /
  grading-standard story (not a product pitch).
- **Tool-roundup inclusion**: pitch inclusion in "best crosslisting app / reseller
  tools" listicles.

## AVOID (per plan §7 IGNORE — these backfire at our domain authority)

- **Paid link buying and PBNs** — existential risk, no upside.
- **Mass generic guest-posting** on marketing blogs — wrong neighborhood; we want
  resale-world relevance, not DR arithmetic.
- **A premature Wikipedia article** — notability isn't there yet; it'll be
  deleted and can backfire. (Wikidata ≠ Wikipedia; Wikidata is fine per §2.)

---

## Absorbed: Reddit distribution playbook (`REDDIT_DISTRIBUTION_PLAYBOOK.md`)

Kept as its own section because it carries an ongoing per-thread log, which is
awkward to interleave with runbook prose. If the log starts filling up, split
this back into a standalone note.

A genuine, disclosed Reddit presence so the GradeThread grading standard gets
retrieved by AI engines (heavily trained on Reddit) and spreads organically in
reseller communities. **This is a human/founder activity — this doc is the
tracked playbook; the code deliverable is the [free printable condition
chart](https://gradethread.com/grading/condition-chart).**

> ⚠️ Not a growth-hack link-drop. Reddit communities punish drive-by promotion,
> and it backfires on the brand. The rule is: **be substantively helpful first,
> disclosed always, and link only when the link genuinely answers the question.**

## Account & disclosure

- Post from the **founder account** (not a brand account), with transparent
  profile flair / bio disclosing the GradeThread affiliation.
- When a comment references GradeThread, disclose in-line ("disclosure: I built
  GradeThread") — every time. Never pretend to be a neutral third party.
- Follow each subreddit's self-promotion rules; when in doubt, don't link.

## Cadence

- **2–3 substantive answers per week**, spread across the target subreddits.
- Quality over volume: one genuinely useful, upvoted answer beats ten thin ones.
- Prioritize **condition-dispute / returns / "is this NWT?" / "how do I describe
  condition?"** threads — the topics where the grading standard is the answer.

## Target subreddits

| Subreddit | Focus | What to answer |
|---|---|---|
| r/Flipping | general reselling | condition, returns, pricing-to-comps |
| r/poshmark | Poshmark sellers | EUC/VGUC/GUC meaning, Posh Protect disputes |
| r/Depop | Depop sellers | condition tags, Buyer Protection claims |
| r/Mercari | Mercari sellers | 5-step condition, not-as-described returns |
| r/eBaySellers | eBay sellers | item conditions, MBG "not as described" cases |
| r/VintageFashion | vintage buyers/sellers | grading vintage condition, disclosure |

## The link, when it fits

Only link when it directly answers the question, and prefer the free assets:

- **The printable condition chart** — `/grading/condition-chart` (shareable, no signup)
- **The grading scale** — `/grading/scale`
- **The returns spine** — `/reselling/reduce-ebay-returns`
- **Platform condition standards** — `/grading/platform-standards/{platform}`

## Tracked threads / answers

Maintain the log below (date · subreddit · thread URL · what was answered ·
whether a link fit · outcome/upvotes). Keeps the effort honest and measurable,
and ties into the §8 measurement loop.

| Date | Subreddit | Thread | Answered | Linked? | Outcome |
|---|---|---|---|---|---|
| _(add rows as you post)_ | | | | | |

## What "good" looks like

- A seller asks "buyer says my "excellent" jacket is worn — what do I do?" → you
  explain how condition disputes resolve, how to disclose accurately next time,
  and (disclosed) link the condition chart. Upvoted, saved, cited.
- A seller asks "what does VGUC mean?" → you answer precisely and link the
  Poshmark platform-standard page. No pitch.

## Related

- [[seo-geo-strategy]] — the bets this measures
- [[ai-crawler-policy]] — the crawler classes behind the referrer stats
- [[INDEX]]
