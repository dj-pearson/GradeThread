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

> **Hand-maintained until US-2045.** The generated regions below are placeholders
> that `scripts/vault-index.mjs` will own. Until then, adding a note means adding
> its line here — the orphan rule in `vault-lint` depends on it.

<!-- vault-index:start -->

## 10-ops — operations and runbooks

- [[dns-and-routing]] — contract — two hostnames, two systems; the wrong one 404s silently.

## 20-domain — grading, measurement, contracts

- [[grading-scale-and-weights]] — contract — the 1.0–10.0 scale, five weighted factors, and the rounding rule that shipped wrong twice.
- [[brand-taxonomy-overview]] — reference — ~830 lines of taxonomy stranded in immutable migration headers, and the plan to free it.

## 30-platform — marketplace integration

- [[ebay-aspect-value-limit]] — contract — 65-char cap rejected at publish, not upload; surfaces as a misleading "already has active offer".

## 40-growth — SEO, content, distribution

- [[seo-public-route-registry]] — contract — the lockstep wiring points for a new indexable page, and the Helmet double-path trap.

## 50-business — pricing and economics

- [[pricing-source-of-truth]] — reference — the doc/constants/Stripe three-way mirror and what keeps it consistent.

## 60-decisions — ADRs

- [[adr-0001-knowledge-vault]] — decision — consolidate 203 markdown files into a navigable wiki; navigate, don't embed.

## 70-agent — how agents work here

- [[agent-knowledge-surfaces]] — reference — four overlapping knowledge surfaces and the intended division between them.

## 90-archive — historical snapshots

Excluded from default navigation. Read only when history is the question.

- [[archive-semantics]] — reference — what belongs here, and why open findings must be extracted before archiving.

<!-- vault-index:end -->

## Meta

- [[CONTRACT]] — note schema, lint rules, editing rules

## Not yet migrated

Most of the corpus still lives at its original paths. Until the Phase 3 stories
land (US-2051 → US-2057), **this index is not complete** — absence from it does
not mean a document does not exist. Check `docs/` and the repo root too.

Tracking: ops US-2051 · domain US-2052 · platform US-2053 · SEO US-2054 ·
business US-2055 · decisions US-2056 · archive US-2057.
