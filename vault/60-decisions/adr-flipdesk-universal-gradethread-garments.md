---
title: "ADR: FlipDesk lists any eBay category, GradeThread grades garments only"
type: decision
status: accepted
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/ai-extract.ts
  - services/edge-functions/src/lib/aspect-registry.ts
  - services/edge-functions/src/lib/ai-grading.ts
reviewed: 2026-08-30
tags: [decision, flipdesk, grading, scope, ebay, aspects]
summary: FlipDesk is a general eBay lister and must fill specifics in any category; the grading rubric, certificate and guarantee stay garments and accessories only. Measured coverage was 67% of aspects in Clothing against 20% in Collectibles before US-3016.
---

# ADR: FlipDesk lists any eBay category, GradeThread grades garments only

> **Decision (owner, 2026-08-30): FlipDesk is a general-purpose eBay lister.
> Anything eBay will list, FlipDesk must be able to list well, which means
> filling that category's item specifics — required and optional. The GRADING
> side of the product — rubric, score, certificate, guarantee — stays garments
> and accessories only, and is not extended to other verticals.**

Raised by the owner while sourcing a Ken doll, a set of antique plates and a
carved Japanese egg. The question was "how well are we set up for non-clothing";
the measurement that followed is the reason this is written down.

---

## 1. Why the boundary is where it is

The two halves of the product have different limits.

**Grading is rubric-bound.** [[grading-scale-and-weights]] defines five factors —
Fabric 30%, Structural 25%, Cosmetic 20%, Functional 15%, Odor 10%. Those are
questions about cloth. A porcelain plate has no fabric and no odor; a die-cast
doll has no seams. Scoring one on that rubric would not be inaccurate so much as
meaningless, and the certificate and the accuracy guarantee
([[grade-accuracy-guarantee]]) are both underwritten by it. Extending the rubric
is not a mapping exercise, it is a second product.

**Listing is category-bound, and eBay supplies the categories.** The item
specifics for any leaf arrive from `getItemAspectsForCategory` and are cached in
`ebay_category_aspects`. The refine pass builds its tool schema from whatever
that returns, so it already asks the model about Card Name, Cover Artist,
Fineness or Creature/Monster Type without anyone having written those down. The
generic path was never clothing-gated — verified 2026-08-30, the only two
`item_category === "clothing"` branches in the whole listing path are a
`clothingDefault` for Size Type and a comment about grading readiness.

So the listing half was *already* general. What was not general was everything
we prepare before the model looks.

## 2. The measurement that made the gap concrete

Run `scripts/aspect-value-coverage.ts --coverage` against prod (read-only, one
cache table). On 2026-08-30, across 121 cached categories:

| Category tree | Categories | Aspects each | Registry reaches |
|---|---|---|---|
| Clothing, Shoes & Accessories | 69 | 31.0 | 20.7 — **67%** |
| Antiques | 1 | 11.0 | 3.0 — **27%** |
| Coins & Paper Money | 1 | 7.0 | 2.0 — **29%** |
| Sports Mem, Cards & Fan Shop | 7 | 16.4 | 4.3 — **26%** |
| Collectibles | 4 | 18.8 | 3.8 — **20%** |
| Toys & Hobbies | 2 | 24.0 | 4.0 — **17%** |

"Registry reaches" is the DETERMINISTIC half: aspects a canonical field fills
without an AI call, which is also what survives a category change. The rest
depends on the refine pass reading photos cold.

**Nothing was blocked.** Collectibles, Antiques and Coins carry zero required
aspects, so those listings publish fine. The cost is findability, not
publishability — a listing missing the optional specifics buyers filter on is a
listing buyers do not reach.

## 3. What was done about it

Under US-3016. All eight new canonical keys target aspect names confirmed
present in the cached payloads rather than guessed at:

| Canonical key | eBay aspect candidates |
|---|---|
| `maker` | Maker, Manufacturer |
| `subject` | Subject |
| `franchise` | Franchise, Universe |
| `production_technique` | Production Technique |
| `year_manufactured` | Year Manufactured, Year of Production, Date of Creation, Publication Year |
| `original_or_reproduction` | Original/Reproduction, Original/Licensed Reprint |
| `signed` | Signed, Autographed, Inscribed |
| `number_of_pieces` | Number of Pieces, Number in Pack |

Each says OMIT for apparel in its prompt description, the way `garment_type`
already does, so a garment run pays schema width and no output.

**The same pass found a defect that had nothing to do with non-clothing.** The
`country_of_manufacture` entry mapped to "Country/Region of Manufacture" and
"Country of Manufacture". Neither name appears in ANY of the 121 cached
categories — eBay calls it **Country of Origin**, and it is present in all 121.
A value read verbatim off the care label had no aspect to land on, on every
listing ever published. See [[ebay-required-aspect-completeness]].

## 4. What this decision does NOT license

- **No grading of non-garments.** No rubric variant, no "collectibles grade", no
  certificate for a plate. If that is ever wanted it is a new product decision
  with its own ADR, not an extension of this one.
- **No per-vertical capture pass.** Every canonical key is sent on every extract
  call, so the set is a shared budget, not a free list. The count is pinned in
  `canonical-attributes_test.ts` precisely so a tenth vertical cannot be added
  without someone noticing the schema is now 80 slots wide. If the set needs to
  grow much further, the answer is category-scoped schemas, not more keys.
- **No claim the non-clothing verticals are finished.** 20% to roughly 50-60% is
  the expected move, not to parity with apparel. The remaining gap is real and
  is best closed by measuring what actually fills on live listings rather than
  by adding more keys speculatively.

## 5. Consequences

- Photo profiles, measurement templates and the grading readiness gate stay
  garment-shaped. A collectible has no required photo set and no measurement
  card, and should not be nagged for one.
- `ITEM_CATEGORIES` already carries `collectibles`, `books`, `electronics`,
  `watches`, `jewelry`, `sports_cards` and `other`, so classification was never
  the blocker.
- The coverage script is the way to re-check this. Re-run it after any change to
  the registry or the capture set; the per-vertical table is the number that
  moves.

## Related

[[grading-scale-and-weights]] · [[grade-accuracy-guarantee]] ·
[[ebay-required-aspect-completeness]] · [[ebay-aspect-value-limit]] ·
[[flipdesk-reseller-gaps]] · [[sync-source-of-truth]]
