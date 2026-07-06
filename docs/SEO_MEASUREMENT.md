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
`functions/_shared/seo-config.ts` + `docs/AI_CRAWLER_POLICY.md`.

## 5. Kill / scale criteria (plan §8)

- If after **6 months** grading-cluster impressions are still **< 1,000/mo** AND
  the prompt panel shows **zero citations**, the definitional wedge needs a
  *distribution* fix (more Reddit/YouTube), not more pages.
- If templated comparison/pSEO tail pages get **< 10 impressions/mo at month 4**,
  prune them — don't accumulate index bloat.
