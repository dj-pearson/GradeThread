---
title: Alias refusals — the words deliberately NOT seeded
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00389_brand_knowledge_base.sql
  - services/edge-functions/src/lib/brand-normalize.ts
reviewed: 2026-09-10
tags: [brands, aliases, false-positives, contract]
summary: An alias that is also an ordinary word or a shared surname false-positives on unrelated goods; several are refused on purpose and must stay refused, and a sub-label that prices differently is refused for a different reason again.
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

## Refused because it is a SUB-LABEL, not a spelling

Added 2026-09-10 (US-3125, `00783`). A different failure from the two above, and
the one most likely to be got wrong by someone doing the obviously helpful thing.

An alias asserts that two strings **name the same entity**. A sub-label that
prices and sizes differently is not the same entity as its house, so folding it
in is not a convenience — it is a wrong claim that the table then reports with
confidence.

`ralphlauren`'s own seeded tell says it out loud:

> the label wording IS the value tier — Chaps is NOT Polo Ralph Lauren

So aliasing **"Lauren Ralph Lauren"** onto `ralphlauren` would have priced a
department-store dress off Purple Label comps and sized it off RL menswear
charts. It got its own `brand_key` instead. The precedent was already in the
table and nobody had written down that it was a precedent: `poloralphlauren` has
been a separate key since `00389`, with its own RN 109514 (`00729`), and `00629`
recorded that folding it into `ralphlauren`'s aliases would **contradict**
`brand-normalize.ts`, which maps that key to its own canonical brand.

### The bar a sub-label has to clear to earn its own key

A source published **by the house** saying the label is separately positioned.
Ralph Lauren Corporation's brands page lists five labels and describes Lauren as
being at "a more accessible price point"; that sentence is the whole
justification.

Refused for now on exactly that test, because nothing sourced says it yet:
**Z Zegna**, **Zegna Couture**, **GANT Rugger**. They are neither aliases nor
keys. Refusing both ways is the honest state — an alias would merge them into a
house they do not belong to, and a key would invent a tier nobody has cited.

> The asymmetry from the general rule below applies in reverse here. A missing
> sub-label key means a seller's item finds no brand row, which is visible and
> cheap. A sub-label folded into its house means the item finds the WRONG brand
> row and is priced off it, which is invisible and expensive.

## A brand_key is derived, not chosen

Also 2026-09-10, and it constrains every row above. `brandKeyForRaw()` in
`brand-normalize.ts` resolves a seller's free-text brand through
`BRAND_ALIASES` and, on a miss, falls through to `brandKey(cleaned)`. So for any
brand not in that map, **the row is only reachable when
`brandKey(canonical_brand)` equals `brand_key`.**

Two consequences:

- **Accents are stripped to nothing**, which is why the KB spells Stussy `stssy`
  and Aime Leon Dore `aimleondore`. Seeding the accented spelling mints a second
  key for the same house.
- **A rename does not get to move the key.** Ermenegildo Zegna now trades as
  ZEGNA, and `00783` still keys it `ermenegildozegna`, because that is what
  sellers type on resale stock and keying it `zegna` would strand every one of
  those items. The current name is an alias.

## The general rule

Before adding an alias, ask what *else* the word matches. If the answer includes
anything that is not this brand, the alias is a false-positive generator, and the
cost is asymmetric: a missing alias means a brand goes unrecognised, while a bad
alias means a *different* brand is confidently mislabelled.

## Related

- [[brand-kb-decoder-bar]] — the same asymmetry applied to style codes
- [[brand-kb-negative-findings]] — other traps recorded to stay recorded
- [[brand-taxonomy-overview]]
