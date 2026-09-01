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

37 notes — see [[moc-ops]].

## 20-domain — grading, measurement, contracts

64 notes — see [[moc-domain]].

## 30-platform — marketplace integration

19 notes — see [[moc-platform]].

## 40-growth — SEO, content, distribution

21 notes — see [[moc-growth]].

## 50-business — pricing and economics

15 notes — see [[moc-business]].

## 60-decisions — ADRs

15 notes — see [[moc-decisions]].

## 70-agent — how agents work here

22 notes — see [[moc-agent]].

## 90-archive — historical snapshots

- [[android-conversion-plan]] — reference — Superseded by the 51-story Android epic in the backlog.
- [[archive-semantics]] — reference — What belongs in 90-archive, how CI treats it, and the rule that stops archiving from burying live work.
- [[code-review-2026-07-04]] — reference — Nine-domain deep-dive review, fully triaged 2026-07-19 — all 93 findings closed; 92 already fixed, 1 mitigated rather than eliminated.
- [[ebay-flips-prd]] — reference — Solo eBay reselling operation currently managed in a Google Sheets flip tracker.
- [[ios-parity-audit]] — reference — Web/iOS feature parity check; 4 of 6 items closed, the remaining two extracted to US-2090.
- [[loop-handoff-passport-epic]] — reference — /loop Loop through all of our open stories in prd.json to work to build out our features.
- [[security-audit-2026-06]] — reference — Self-reports all findings and follow-ups addressed, no open items.

<!-- vault-index:end -->

## For humans in Obsidian

- [[live-views]] — Dataview queries that compute themselves: contract notes,
  the review queue, expired decisions. **Agents cannot run these** — they read
  the list below instead. Both come from the same frontmatter
  ([[adr-0003-dual-consumer-vault]]).

## Maintenance

- [[review-cadence]] — run `npm run vault:lint -- --report` when CI warns.
  Event-driven, not scheduled: the observed drift rate is zero at 89 notes.

## Evidence

- [[benchmark-2026-07-19]] — navigating this vault costs 89% less than the old
  corpus; **grepping it blindly costs 16% MORE**. Read the protocol above.

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
