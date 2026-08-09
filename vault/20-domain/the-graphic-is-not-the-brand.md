---
title: The graphic is not the brand
aliases: [logo is not the brand, course logo, band tee brand field]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00579_vintage_tee_blanks_brand_knowledge.sql
  - supabase/migrations/00583_golf_brand_knowledge.sql
  - services/edge-functions/src/tests/golf-content_test.ts
reviewed: 2026-08-09
tags: [brands, listings, grading, contract]
summary: On a band tee, a golf polo and anything licensed, the mark people care about is not the maker — the brand field takes the neck label, and the graphic is a separate fact.
---

# The graphic is not the brand

Some garments carry **two identities**: who made the blank, and whose mark is
printed on it. They are different fields, and collapsing them mis-files the item
and breaks its comp set.

> **The brand field takes the NECK LABEL. The graphic is a separate fact.**

## Three instances, one rule

| garment | the maker (brand field) | the graphic (separate) |
|---|---|---|
| **Band tee** (`00579`) | Screen Stars, Brockum, Giant, Winterland | the band, the tour, the print |
| **Golf polo** (`00583`) | FootJoy, Greyson, Callaway | the club, tournament, resort or corporate outing |
| **Licensed sports cap** (`00574`) | New Era | the team |

In every case **the graphic is what most buyers are actually shopping for** — and
it is still not the brand. A Pebble Beach logo does not make a polo a "Pebble
Beach" product; a Nirvana print does not make a tee a "Nirvana" product.

## Why the field matters more than it looks

Putting the graphic in the brand field does three things, all bad:

1. **It mis-files the item.** Brand resolution feeds the pack lookup, so a
   garment filed under a course gets no maker's sizing, tells or baselines.
2. **It breaks the comp set.** Comps are pulled per brand. A brand nobody else
   uses returns nothing, or returns an unrelated cluster.
3. **It is not reversible from the row.** Once the neck label is gone from the
   record, nothing downstream can recover which blank it was.

Alias maps therefore carry **no course, club, tournament or band names**, and a
test asserts it: `Pebble Beach`, `Augusta`, `Augusta National`, `Ryder Cup` and
`PGA` all stay unmapped in `brand-normalize.ts`.

## The graphic still has to be transcribed

Refusing it as a *brand* is not refusing it as a *fact*. It belongs in the title
and the description, because it is usually the reason the item sells — and
because **it cuts both ways**:

- a famous course or a sought band is why a particular buyer wants it;
- a corporate-outing logo or an unknown local club **narrows** the market, since
  it is somebody else's company on your chest.

⚠ **No premium figure is claimed anywhere.** That these marks trade actively is
observable; how much they add is not something the corpus could source, and an
invented multiplier would be worse than silence. Name the graphic and let the
comps price it — a golf content test greps the seeded prose for a numeric premium
and fails if one appears.

## Related

- [[brand-kb-negative-findings]] — the vintage-tee side, and why a blank maker has no styles
- [[brand-taxonomy-overview]] — where per-brand values live versus per-corpus rules
- [[brand-kb-sizing-units]] — the other field these categories keep getting wrong
