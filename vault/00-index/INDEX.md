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

- [[dns-and-routing]] — contract — Two hostnames serve two different systems; calling an app route on the Supabase host 404s silently.
- [[runbook-copies]] — reference — Ops procedures are duplicated across repo root, docs/, and a shipped in-app admin feature — and the in-app copy is the one on-call actually reads.

## 20-domain — grading, measurement, contracts

- [[brand-taxonomy-overview]] — reference — Where brand and garment taxonomy currently lives, why that is a problem, and how it gets extracted in US-2058.
- [[grading-scale-and-weights]] — contract — The 1.0-10.0 scale, the five weighted factors, and the rounding rule that has now shipped wrong twice.

## 30-platform — marketplace integration

- [[ebay-aspect-value-limit]] — contract — eBay rejects aspect values over 65 chars at publish, not at upload - which is why the error surfaces as an unrelated "already has active offer".

## 40-growth — SEO, content, distribution

- [[seo-public-route-registry]] — contract — A new indexable page must be registered in several places in lockstep; CI guards catch some omissions but not all.

## 50-business — pricing and economics

- [[pricing-source-of-truth]] — reference — Pricing has a doc and a code mirror that must change together; this note records the contract until docs/PRICING.md moves here in US-2055.

## 60-decisions — ADRs

- [[adr-0001-knowledge-vault]] — decision — Consolidate 203 scattered markdown files into one navigable wiki; retrieve by link traversal rather than embeddings.

## 70-agent — how agents work here

- [[agent-knowledge-surfaces]] — reference — Four places currently hold agent-facing knowledge; this note defines the intended division and tracks the unification.
- [[guards-that-cannot-fail]] — learning — This repo's most common defect is not a broken check but a check that passes for the wrong reason; here are the seven shapes it took and the one habit that catches all of them.

## 90-archive — historical snapshots

- [[archive-semantics]] — reference — What belongs in 90-archive, how CI treats it, and the rule that stops archiving from burying live work.

<!-- vault-index:end -->

## Migration status

- [[STUBS]] — redirect stubs left at old doc paths, swept in US-2065

## Not yet migrated

Most of the corpus still lives at its original paths. Until the Phase 3 stories
land (US-2051 → US-2057), **this index is not complete** — absence from it does
not mean a document does not exist. Check `docs/` and the repo root too.

Tracking: ops US-2051 · domain US-2052 · platform US-2053 · SEO US-2054 ·
business US-2055 · decisions US-2056 · archive US-2057.
