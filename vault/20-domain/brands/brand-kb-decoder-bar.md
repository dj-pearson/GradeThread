---
title: The decoder bar — three tests, all required
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00460_luxury_outerwear_brand_knowledge.sql
reviewed: 2026-07-19
tags: [brands, grading, decoder, contract]
summary: A style code becomes a decoder only if it is tag-printed AND regular AND brand-unique in format; the third test is the one that fails, and failing it mints false positives.
---

# The decoder bar — three tests, all required

A **decoder** is a seeded pattern that recovers a brand from a style code on a
tag. It is powerful precisely because it works when the brand tag has been cut
off — and dangerous for the same reason.

Established in `00460` (US-1736 / US-1740) and applied by every later pack:

> **tag-printed AND regular AND brand-unique IN FORMAT**

All three. The bar is quoted verbatim across at least eight packs, which is how a
rule written once became the corpus's standard.

## The third test is the one that fails

Tag-printed and regular are easy. **Brand-unique in format** is what most codes
fail, and failing it does not merely lose a signal — it *mints a false positive*
from any tag that happens to carry a similar-shaped string.

| Code | Tag-printed | Regular | Brand-unique | Seeded? |
|---|:--:|:--:|:--:|---|
| Canada Goose `4660MA` (4 digits + M/L) | ✓ | ✓ | ✓ | **Yes** — names the model outright, recoverable from a cut tag |
| ASICS 8-char article (digits-then-letter) | ✓ | ✓ | ✓ | **Yes** — a shape Nike/adidas/Reebok/New Balance do not use |
| Fossil `ES5331` / `FTW1234` | ✓ | ✓ | ✓ | **Yes** — on the metal case back; a watch is not a bag |
| Reebok `GY7434` (2 letters + 4 digits) | ✓ | ✓ | **✗** | **No** — that format is *adidas's* |
| PUMA 6-digit `380190` | ✓ | ✓ | **✗** | **No** — bare digit run |
| Lee `101`, Chanel serial, Moncler serial, Balenciaga tab | ✓ | ✓ | **✗** | **No** — bare digit runs |
| Canada Goose hologram number | ✓ | ✓ | **✗** | **No** — bare digit run, and not proof of anything |

### The Reebok case is the clearest argument for the third test

Reebok's modern codes are tag-printed and perfectly regular. They are still not
seeded, because **adidas owned Reebok from 2006 to 2021 and the two ran a shared
corporate coding system**. A pattern over that format would mis-brand adidas
shoes as Reebok *and* Reebok shoes as adidas — "the tag's own brand would lose to
a format guess."

Two of three tests passing is not a near miss. It is the failure mode.

## What to do with a code that fails the bar

**Transcribe it, never let it recover a brand.** A PUMA six-digit number is worth
carrying into a listing verbatim — buyers search it — but it must never be the
evidence that the item *is* a PUMA.

Where a code is an ordinary English phrase, it additionally needs corroboration:
Rag & Bone's men's denim runs `Fit 1`–`Fit 4`, printed on the tag and genuinely
regular, but "Fit 2" would false-recover the brand from any tag using those two
words. Carry it into the title; require a Rag & Bone tag before treating it as
brand evidence.

## Related

- [[brand-kb-alias-refusals]] — the same false-positive logic applied to brand names
- [[brand-kb-negative-findings]] — traps recorded so they are not re-introduced
- [[brand-taxonomy-overview]] — why these rules live here and not in the database
- [[grading-scale-and-weights]] — what consumes brand identification
