---
title: Brand knowledge base — what lives where
type: reference
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00389_brand_knowledge_base.sql
reviewed: 2026-07-19
tags: [grading, brands, taxonomy, moc]
summary: Per-brand values live in the database; the per-corpus rules that govern them had no column and lived only in immutable migration headers until US-2058.
---

<!-- vault-move:no-rewrite -->

# Brand knowledge base — what lives where

## The split

| Kind of knowledge | Lives in | Authority |
|---|---|---|
| Per-**brand** values — aliases, `tag_eras`, `country_patterns`, `authentication_tells`, decoders, colorways, size charts | the database (`brand_knowledge` + 5 sibling tables) | **the DB** |
| Per-**corpus** rules — what qualifies as a decoder, what may be an alias, what a recorded negative means | **these notes** | **the vault** |

The grader reads the database. It never reads these notes. That is intentional:
notes carry the *reasoning*, rows carry the *values*, and conflating them is how
a note starts drifting from the table it describes.

**Do not restate row data here.** If you find a brand's aliases listed in a note,
that copy is wrong by construction — delete it and query the table.

## Why the rules needed extracting

37 `*_brand_knowledge.sql` migrations carry **2,259 lines of header comments**
across 12,059 total lines. Those headers are not decoration; they contain the
research reasoning behind every seeded row, and they cite each other constantly —
`00389` is referenced 126 times, `00468` 118 times, `00454` 109 times. A citation
network of that density is a wiki trying to exist inside SQL comments.

**The audit answer (US-2058):** the schema has columns for aliases, tells, eras,
patterns, decoders, colorways and size charts — all **per-brand**. It has no
column, and could not sensibly have one, for a rule that spans the corpus: the
decoder bar, the sourcing policy, or *why* a negative was recorded. Those are not
attributes of any single brand.

So the finding is not "taxonomy failed to reach a row". It is structural:

> **The per-brand data is in the database. The rules that govern it never had
> anywhere to go, so they went into immutable migration headers — where they
> cannot be edited, are not indexed, and no grading work will surface them.**

Applied migrations are immutable. Correcting a fact in one of those headers is
not possible without writing another migration whose only purpose is a corrected
comment, which nobody does. The rules were write-once.

## The extracted rules

- [[brand-kb-decoder-bar]] — tag-printed AND regular AND brand-unique; the third
  test is the one that fails, and failing it mints false positives
- [[brand-kb-alias-refusals]] — the words deliberately NOT seeded, and why an
  alias cannot express "only when pre-2003"
- [[brand-kb-negative-findings]] — RN 17257 is not Longchamp; why a missing RN on
  a handbag is *correct*; folklore that survives repetition

## Scope correction

The story that commissioned this (US-2058) described **five** migrations and
~830 header lines. That was the top five *by header size*
(`00457`, `00458`, `00459`, `00467`, `00468` — 819 lines between them). The real
corpus is **37 migrations and 2,259 header lines**, roughly 2.7× the estimate.

This pass extracted the **cross-cutting rules**, which is where the
unrecoverable knowledge concentrated. Per-brand narrative in the remaining
headers is largely mirrored by the `notes` column on each row, so it is
queryable even though it is not indexed. If per-family notes are wanted later,
that is a separate piece of work against a corpus that is now understood.

## Related

- [[grading-scale-and-weights]] — what consumes brand identification
- [[adr-0001-knowledge-vault]] — why extraction was worth doing
- [[INDEX]]
