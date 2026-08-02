---
title: Changing a category — what cascades, and what the seller keeps
aliases: [category coupling, garment axis, remap specifics, parked aspects]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/ebay-prefill.ts
  - src/lib/ebay-category-map.ts
  - src/lib/garment-mapping.ts
  - src/lib/grading-readiness.ts
reviewed: 2026-08-01
tags: [flipdesk, grading, ebay, contract]
summary: An item carries three category axes that must agree; correcting one cascades into the others, and the specifics a change cannot carry are set aside rather than destroyed.
---

# Changing a category — what cascades, and what the seller keeps

An item carries **three** category axes:

| Axis | Decides |
|---|---|
| `item_category` (coarse) | which vertical the app treats it as |
| `garment_type` / `garment_category` | grading readiness **and which grading criteria apply** |
| `ebay_category_id` (leaf) | the item specifics eBay will accept |

They must agree. Correcting one in isolation leaves an item that looks fine and
grades against the wrong rubric.

## The cascade

**eBay leaf → coarse → garment.** `ebayPathToItemCategory(breadcrumb)`
(`src/lib/ebay-category-map.ts`) reverse-maps the chosen eBay path. It reads the
**descendant** segments, because the root "Clothing, Shoes & Accessories" names
several verticals at once, and it **returns null when unsure** rather than
guessing. The composer then writes `item_category` in the same save, plus
`garment_type`/`garment_category` — but **only when the coarse FAMILY changes**
(`deriveGarmentType(next) !== deriveGarmentType(current)`), so a same-family
correction keeps the seller's own garment pick.

That restraint is the point: the cascade exists to stop axes drifting apart, not
to overwrite deliberate choices.

> [!warning] The manual route does not cascade (US-2384, found 2026-08-01)
> Changing the coarse category **by hand** in Item details writes
> `item_category` alone. The garment axis keeps pointing at the old family, so a
> clothing → shoes correction still grades as clothing. Grading readiness does
> not catch it, because both garment fields are non-empty — they are simply
> wrong. The manual half lived on `item-canvas.tsx` and went with the file.
>
> One flag is doing two jobs here: `categoryTouched` correctly stops the
> eBay-path derivation overwriting a manual pick, and incidentally suppresses the
> garment derivation too.

**What does not cascade, deliberately:** a coarse-category change does not pick
an eBay leaf. Mapping a vertical to a specific leaf is not safe to automate, so
that direction stays seller-driven.

## Specifics survive a category change, or are set aside

`remapAspectsForCategory` returns `{kept, remapped, remappedFrom, derived,
dropped, rewrites}`:

- **kept** — the name exists verbatim in the new spec.
- **remapped** — the same concept under a different name. `findEquivalentAspect`
  matches by `normalizeAspectName` (lowercase, British→US spelling fold,
  strip non-alphanumerics, so "Colour" → "Color"), then a small curated synonym
  table for colour/material/size. Every re-home is **gated by `fillAspect`**, so a
  value the target cannot accept is parked rather than mis-filed.
- **derived** — refilled from the item's columns and canonical attributes.
- **dropped** — genuinely has no home here.

Dropped values are **parked, not discarded**: `parkedRef` in the picker holds
them, and each later commit restores whatever fits the new category. Switching
back recovers them, and the confirm dialog says "set aside" for that reason.

Two limits worth knowing: parking is **session-only** (persisting it needs a
migration), and `kept` does **not** re-validate values against the new spec, so a
same-named SELECTION_ONLY aspect can retain an out-of-domain value.

## Grading readiness reacts live, without a save

`previewGradingReadiness` (`src/lib/grading-readiness.ts`) is a pure client
mirror of the edge `buildValidation()` — same rules, same blocker strings, locked
by a test. It exists because photos write to `item_photos` immediately without
bumping `updated_at`, so a card keyed on the saved row never noticed them.

Submit still persists title and the garment fields **before** calling submit, so a
card that says Ready always passes the authoritative server check.

## Related

- [[sync-source-of-truth]] — which field owns which specific
- [[grading-scale-and-weights]] — what the garment axis selects
- [[listing-photos]] — the other half of grading readiness
- [[INDEX]]
