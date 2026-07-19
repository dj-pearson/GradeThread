---
title: Vault index
type: moc
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-18
tags: [meta, moc]
summary: Start here. Every vault note is reachable from this page.
---

# Vault index

**Start here.** Read this page, follow at most two links, then stop. If you are
reading a third hop, the taxonomy is wrong — say so rather than working around it.

For **code** questions, go to the code. This vault holds contracts, runbooks,
decisions and taxonomy — not API surface.

New here? Read [[CONTRACT]] before adding a note.

> **The list below is generated** by `scripts/vault-index.mjs` from note
> frontmatter. Don't hand-edit between the markers — run `npm run vault:index`.
> Everything outside them is hand-written and is preserved.

<!-- vault-index:start -->

## Meta

- [[CONTRACT]] — contract — The frontmatter schema every vault note must satisfy, and the rules vault-lint enforces.

## 10-ops — operations and runbooks

20 notes — see [[moc-ops]].

## 20-domain — grading, measurement, contracts

- [[brand-taxonomy-overview]] — reference — Where brand and garment taxonomy currently lives, why that is a problem, and how it gets extracted in US-2058.
- [[garment-passport-privacy]] — contract — What a passport may expose publicly, and the salted-hash rule that keeps it de-identified.
- [[grading-scale-and-weights]] — contract — The 1.0-10.0 scale, the five weighted factors, and the rounding rule that has now shipped wrong twice.
- [[measurement-accuracy]] — contract — Tolerances the measurement pipeline must hold and how accuracy is validated.
- [[measurement-card-spec]] — contract — The printed reference card: dimensions, tolerances and why the print scale must not drift.
- [[support-assistant]] — reference — How the support assistant is scoped, what it may answer, and its escalation path.
- [[sync-source-of-truth]] — contract — Provenance model, field ownership and linking-source rules for bidirectional marketplace and sheet sync.

## 30-platform — marketplace integration

- [[cross-listing]] — reference — Direct marketplace APIs versus aggregators, and which channels are reachable how.
- [[ebay-aspect-value-limit]] — contract — eBay rejects aspect values over 65 chars at publish, not at upload - which is why the error surfaces as an unrelated "already has active offer".
- [[ebay-condition-and-policies]] — contract — Condition validation lives on the Sell Metadata API, not Taxonomy, and apparel rejects LIKE_NEW — both failures are silent until publish.
- [[ebay-ranking-playbook]] — reference — What actually moves Best Match placement, and what is folklore.
- [[ebay-trading-api-watch]] — reference — Deprecation exposure on the legacy Trading API and what would force a migration.
- [[flipdesk-dogfood]] — reference — What broke when the pipeline was run end to end on real inventory.
- [[flipdesk-reseller-gaps]] — reference — Where the reseller workflow still falls short of what a working seller needs.

## 40-growth — SEO, content, distribution

- [[ai-crawler-policy]] — decision — Which AI crawlers may cite, which may train, and which are blocked — an approved decision with an env override.
- [[content-publishing]] — contract — The webhook fan-out contract for publishing a post to every downstream channel.
- [[content-scheduler]] — runbook — How scheduled posts are queued, fired and recovered when a run is missed.
- [[copy-style-guide]] — reference — Voice, tone and the claims copy is not allowed to make.
- [[seo-distribution-and-measurement]] — runbook — How attention is earned off-page and on Reddit, and how to tell whether any of it worked.
- [[seo-geo-strategy]] — reference — Keyword universes, site architecture and the phased roadmap for making GradeThread the citable condition standard.
- [[seo-indexability]] — reference — Why registered pages are not getting indexed, and the open work to fix it — including the argument against more pSEO.
- [[seo-performance-images]] — reference — The shipped performance levers, the Cloudflare toggles still to enable, and how responsive images are actually gated.
- [[seo-public-route-registry]] — contract — A new indexable page must be registered in several places in lockstep; CI guards catch some omissions but not all.
- [[seo-technical-guards]] — contract — What CI enforces about the HTML crawlers actually receive, and how to read each failure.

## 50-business — pricing and economics

- [[ai-profitability]] — reference — Per-surface model choice, unit cost and margin, with the keep/downgrade call for each.
- [[deliverability]] — runbook — SES/SMTP configuration, warmup, DMARC alignment and what to check when mail stops landing.
- [[google-ads-setup]] — runbook — Account structure, conversion wiring and the gclid path for the Ads Command Center.
- [[newsletter-tuning]] — runbook — Cadence, segmentation and the levers that move open and click rates.
- [[passport-forecast]] — reference — Volume and revenue projection for the passport surface.
- [[pricing]] — contract — The single source of truth for every price; src/lib/constants.ts is its machine-readable mirror and must change in the same commit.
- [[subscription-unit-economics]] — reference — Cost per tier at realistic and worst-case utilization, and why the AI-action caps sit where they do.

## 60-decisions — ADRs

- [[adr-0001-knowledge-vault]] — decision — Consolidate 203 scattered markdown files into one navigable wiki; retrieve by link traversal rather than embeddings.
- [[adr-comps-pseo]] — decision — Whether to build programmatic comp pages, and why the answer turned on indexation risk.
- [[adr-depop-partner-application]] — decision — The Depop API partnership application, what it requires and what it unlocks.
- [[adr-graphify-pilot]] — decision — The Graphify pilot, its scope and the criteria for continuing or stopping.
- [[adr-poshmark-via-extension]] — decision — Why Poshmark/Mercari/Grailed are reached through the browser extension rather than an aggregator contract.
- [[adr-referral-cash-payout]] — decision — Whether referral rewards pay cash, and the compliance and abuse constraints that shaped the answer.

## 70-agent — how agents work here

- [[agent-knowledge-surfaces]] — reference — Four places currently hold agent-facing knowledge; this note defines the intended division and tracks the unification.
- [[guards-that-cannot-fail]] — learning — This repo's most common defect is not a broken check but a check that passes for the wrong reason; here are the seven shapes it took and the one habit that catches all of them.

## 90-archive — historical snapshots

- [[archive-semantics]] — reference — What belongs in 90-archive, how CI treats it, and the rule that stops archiving from burying live work.

<!-- vault-index:end -->

## Also registered here

- [[external-docs]] — docs that deliberately stay next to the code they configure
  (edge deploy/setup, iOS release, extension). Findable, not moved.

## Migration status

- [[STUBS]] — redirect stubs left at old doc paths, swept in US-2065

## Not yet migrated

Most of the corpus still lives at its original paths. Until the Phase 3 stories
land (US-2051 → US-2057), **this index is not complete** — absence from it does
not mean a document does not exist. Check `docs/` and the repo root too.

Tracking: ops US-2051 · domain US-2052 · platform US-2053 · SEO US-2054 ·
business US-2055 · decisions US-2056 · archive US-2057.
