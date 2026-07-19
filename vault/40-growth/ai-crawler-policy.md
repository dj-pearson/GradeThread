---
title: AI crawler policy
type: decision
status: accepted
source_of_truth: code
code_refs:
  - functions/_shared/seo-config.ts
reviewed: 2026-07-19
tags: [seo, ai, crawlers, decision]
summary: Which AI crawlers may cite, which may train, and which are blocked — an approved decision with an env override.
---
# AI-Crawler Policy (US-430)

**Owner:** Pearson Media LLC
**Decision date:** 2026-06-12
**Status:** Approved (stakeholder-reviewed)
**Enforced by:** `functions/_shared/seo-config.ts` → `/robots.txt` and `/llms.txt`
**Tests:** `src/test/seo-crawl.test.ts`

## The decision

GradeThread's public surface is **marketing content we want AI engines to read,
quote, and cite**. We therefore make a deliberate, explicit split between the two
kinds of automated access — they are different questions with different answers:

| Class | What it is | Policy | Configurable? |
|---|---|---|---|
| **Citation / search** | Live retrieval + answer-engine citation (quotes + links back). | **Always allowed.** Pure GEO upside. | No |
| **Training** | Content may be ingested into model training corpora. | **Allowed by default.** | Yes — `AI_TRAINING_CRAWLERS` |
| **Aggressive scrapers** | Ignore robots / no attribution / known to hammer origins. | **Always blocked.** | Via `BLOCKED_AI_AGENTS` |

### Why allow training by default?

1. The public site is marketing. Presence in training corpora strengthens brand
   recall when models answer condition-grading questions from memory.
2. Nothing proprietary is exposed: the full grading rubric, customer data, and
   the dashboard/admin/API surfaces are already `Disallow`ed for everyone
   (`DISALLOWED_PATHS`) and sit behind auth.
3. Blocking training crawlers (GPTBot et al.) has, to date, no proven citation
   benefit and risks excluding us from the corpora that shape AI answers.

**Revisit if** non-marketing, proprietary content (e.g. the complete grading
methodology, or any customer/seller data) ever becomes publicly crawlable — at
that point flip training off via the env var below.

## The crawlers

**Citation / search (always `Allow: /`)** — `CITATION_AI_AGENTS`:
Googlebot, Bingbot, OAI-SearchBot, ChatGPT-User, Claude-User, PerplexityBot,
Perplexity-User, Applebot.

**Training (`Allow: /` by default, configurable)** — `TRAINING_AI_AGENTS`:
GPTBot (OpenAI), ClaudeBot (Anthropic), Google-Extended (Gemini/Vertex),
Applebot-Extended (Apple Intelligence), CCBot (Common Crawl).

> **US-1666 (SEO 2.0):** CCBot moved from hard-blocked to training-allowed.
> Common Crawl feeds a large share of AI training corpora; for a category-creation
> GEO play we WANT the published condition standard/glossary memorised, and the
> crawlable content is public marketing. It follows the `AI_TRAINING_CRAWLERS`
> toggle like the other training crawlers.

**Hard-blocked (always `Disallow: /`)** — `BLOCKED_AI_AGENTS`:
Bytespider, Diffbot, Omgilibot, ImagesiftBot.

## How to change the policy (no code change)

Set the Cloudflare Pages env var **`AI_TRAINING_CRAWLERS`** (exposed to the
Functions runtime):

- _unset_ / `allow` / anything else → training crawlers **allowed** (default).
- `disallow` / `block` / `off` / `false` / `no` / `0` → training crawlers get
  `Disallow: /` in `robots.txt`. Citation crawlers are unaffected.

To block additional scrapers, add their user-agent to `BLOCKED_AI_AGENTS` in
`functions/_shared/seo-config.ts` (a one-line edit; handler code is untouched).

## Where it shows up

- **`/robots.txt`** — per-agent `Allow`/`Disallow` blocks built by
  `buildRobotsTxt()`; the training class flips with `allowTraining`.
- **`/llms.txt`** — carries `AI_CRAWLER_POLICY_NOTE` (a one-line usage statement
  asking for citation + link-back) under the summary.

## Related

- [[seo-distribution-and-measurement]] — how citation traffic is observed
- [[seo-geo-strategy]] — being citable is the point of the policy
- [[INDEX]]
