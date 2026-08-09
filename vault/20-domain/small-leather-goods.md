---
title: A wallet is not a small bag
aliases: [small leather goods, SLG, wallets]
type: reference
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00577_small_leather_goods_brand_knowledge.sql
  - services/edge-functions/src/tests/small-leather-goods-content_test.ts
reviewed: 2026-08-09
tags: [grading, brands, accessories, wallets]
summary: A wallet's only maker's mark sits on the panel the hand grips, so identifiability degrades with condition — and two of the category's leading brands make their flagship out of metal, which a leather rubric cannot read at all.
---

# A wallet is not a small bag

Seeded with `00577` (US-2221). The handbag pack (`00468`) was built on one
sentence: *a bag carries less recoverable information on its body than a garment
does.* Small leather goods take that one step further, and the step is larger
than the wording suggests.

## Identifiability degrades with condition

A garment has a sewn care label. A bag has a hangtag, and sometimes a sewn creed
patch — Coach's carries the style number, which is why Coach got a decoder and
the other eight bag brands did not. **A wallet has neither.** Its only mark is a
small blind emboss or foil stamp on a panel that is gripped, folded and pocketed
every day.

So the mark wears off *in proportion to use*:

> **The more a wallet has been used, the less recoverable its brand is.**

That coupling exists nowhere else in the corpus, and it has one operational
consequence worth stating plainly: **a blank-looking wallet is evidence of use,
not evidence of a no-name item.** A grader that does not know this reads a
well-loved Bosca as unbranded.

## A house's wallet is not its bag

Coach, Louis Vuitton, Gucci, Dooney & Bourke and Fossil all have packs, and every
one was written around **bags**. Their small leather goods sit on a different
price ladder, wear at different points, and are counterfeited at different rates.

A wallet must never inherit a bag's grading or a bag's comp set, even from the
same house. That is what "distinct class" means operationally — not a taxonomy
label, a refusal to reuse a ladder.

## The category's name is wrong, and it is a grading problem

"Small **leather** goods" — and two of the four brands seeded make their flagship
out of metal. The Ridge is aluminium, titanium or carbon fibre. Secrid's
Cardprotector is anodised aluminium, plastic and stainless steel; only its
Miniwallet wraps that core in leather.

A leather rubric returns nonsense on those: there is no grain to scuff, no patina
to develop, no dryness to assess. Meanwhile the real failure modes have no
leather analogue at all:

| Metal wallet | What actually fails |
|---|---|
| Body | anodising worn through at the corners, scratches to bare metal |
| Plates | bent, sprung, no longer parallel |
| Retention | elastic stretched or torn, money clip lost tension |
| Mechanism | Secrid's slide no longer springs or fans the cards |

On a Secrid the mechanism *is* the product. A listing that photographs the
outside and says nothing about the action has not described the item.

## Where a leather wallet actually wears

Unlike a garment, wallet wear is concentrated and predictable. Four places carry
nearly all of it:

- **The spine** — the fold cracks, then splits.
- **The card slots** — leather stretches permanently. A slot that has held a card
  for a year does not come back.
- **The corners** — abrade first, against the pocket seam.
- **The bill compartment lining** — tears along the top edge, and is the defect
  most often missing from listing photos, because nobody opens it.

## ⚠ Patina is the product, not the defect

Bosca's signature line is called **Old Leather** and the house sells it on
"signature patinas that only improve with age, use & adventure" — hand-stained
Italian leather that deepens into a gloss.

Grading that darkening as soiling marks the item down for doing the one thing it
was designed to do. Same error class as reading a Persol Meflecto stem as a loose
arm, or a vachetta bag's darkening as a stain.

The seeded tell redirects to the real defects — cracking, a split spine,
stretched slots — because removing a signal without replacing it just leaves the
grader blind.

## Related

- [[brand-kb-decoder-bar]] — why no brand here gets a decoder
- [[brand-kb-sizing-units]] — the sibling question: which numbers on an item mean anything
- [[brand-taxonomy-overview]] — why per-brand values live in the DB and rules live here
- [[grading-scale-and-weights]] — what consumes this
