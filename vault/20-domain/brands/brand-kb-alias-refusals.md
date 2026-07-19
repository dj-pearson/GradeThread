---
title: Alias refusals — the words deliberately NOT seeded
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00389_brand_knowledge_base.sql
reviewed: 2026-07-19
tags: [brands, aliases, false-positives, contract]
summary: An alias that is also an ordinary word or a shared surname false-positives on unrelated goods; several are refused on purpose and must stay refused.
---

# Alias refusals — the words deliberately NOT seeded

`brand_knowledge.aliases` resolves misspellings and short forms to a canonical
brand. A **bare common word** must never be in it: the alias fires on any listing
containing that word, and the brand is then asserted on evidence that is not
evidence.

Each refusal below is recorded in a migration header as deliberate. **A future
researcher will look at the row, see an "obviously missing" alias, and add it.**
That is the failure this note exists to prevent — the absence looks like an
oversight and is not.

## Refused because the word is ordinary

| Brand | Refused alias | Why |
|---|---|---|
| Canada Goose | `goose` | ordinary word |
| Brooks | bare `Brooks` | ordinary surname — `00467`'s headline refusal |
| L.L.Bean | `bean` | ordinary English word |
| Citizens of Humanity | `citizens` | ordinary English word |
| Joe's Jeans | `joe` | ordinary given name |
| Duluth Trading | bare `duluth` | **Duluth Pack (est. 1882) is a different company.** The match must be `duluth trading` |
| Faherty | bare `Faherty` | common Irish surname; the trademark register carries unrelated Faherty owners, so it false-positives on non-apparel goods |

## Refused because an alias cannot express a time window

The sharpest case, and the one worth understanding rather than memorising:

**`structure` is not an Express alias.** Structure was Express's menswear label
from 1989, reabsorbed as "Express Men" in 2001 — but **Express sold the Structure
name to Sears in 2003.** So a Structure tag is an Express garment *only* in the
1989–2001 window; a later one is Sears'.

> An alias cannot express "only when pre-2003".

The aliases column is a flat set membership test. Knowledge with a temporal
condition does not fit in it, and forcing it in produces a confident wrong answer
on every post-2003 Sears garment. It belongs in `tag_eras` as a dating tell
instead — which is where it went.

## The general rule

Before adding an alias, ask what *else* the word matches. If the answer includes
anything that is not this brand, the alias is a false-positive generator, and the
cost is asymmetric: a missing alias means a brand goes unrecognised, while a bad
alias means a *different* brand is confidently mislabelled.

## Related

- [[brand-kb-decoder-bar]] — the same asymmetry applied to style codes
- [[brand-kb-negative-findings]] — other traps recorded to stay recorded
- [[brand-taxonomy-overview]]
