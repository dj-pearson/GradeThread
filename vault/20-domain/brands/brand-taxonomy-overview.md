---
title: Brand knowledge base — what lives where
type: reference
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00389_brand_knowledge_base.sql
reviewed: 2026-07-28
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

## brand_styles coverage is ~95%, not "a fraction"

Recorded 2026-07-28 (US-2216) because the story that set out to fix this gap had
the gap wrong, and the wrong number would have driven weeks of unnecessary
seeding.

US-2216 read "70 migration statements insert into `brand_knowledge` but only 36
insert into `brand_styles`" as a coverage ratio. **Those are FILE counts.** One
migration seeds many brands. Counted properly:

| | |
|---|---|
| brands in `brand_knowledge` | 188 |
| `brand_styles` rows | 706 |
| brands with ≥1 style | 178 (**95%**) |
| brands with NO style | 10 |
| brands with exactly 1 style | 2 |

`scripts/brand-style-coverage.mjs` produces this, and
`brand-style-coverage_test.ts` pins it so the "a fraction" reading cannot return.

### Counting the packs correctly is harder than it looks

Three tuple layouts occur across the packs, and a parser handling only the first
under-counts silently:

```sql
  ('zara', 'Zara', ...          -- one tuple per line
values ('nike', 'Nike', ...     -- tuple on the values line
values (
  'lululemon', ...              -- tuple opened, key on the next line
```

A first pass here handled only the line-anchored form, reported 53 statements
unparsed, counted 162 brands instead of 188, and put brands in the
"no styles" list that were not missing. **Any script that counts the packs must
report its unparsed statements** — a silent floor is how a wrong premise gets
believed.

### The ten uncovered brands, and why some should stay uncovered

`aeropostale, carharttwip, eddiebauer, gildan, guess, hanes, harleydavidson,
hollister, nautica, poloralphlauren`

Not all are gaps. **Gildan and Hanes are blanks manufacturers** — their garments
have no model identity worth naming, and a style row for them would be noise in
every prompt that resolves their pack. Aeropostale, Hollister and Guess are mall
brands whose value does not turn on the model. The four worth seeding are
**Eddie Bauer, Nautica, Harley-Davidson and Polo Ralph Lauren**, each of which
has named, collectible lines.

Absence is sometimes correct here too — see [[brand-kb-negative-findings]].

## Related

- [[brand-kb-provenance]] — every row must say where it came from, and both rules are enforced NOT VALID
- [[brand-kb-sizing-units]] — why a size chart is keyed by brand and never converted across brands
- [[grading-scale-and-weights]] — what consumes brand identification
- [[adr-0001-knowledge-vault]] — why extraction was worth doing
- [[INDEX]]
