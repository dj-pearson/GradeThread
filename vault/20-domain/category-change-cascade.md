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
reviewed: 2026-08-03
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

**Both routes derive the garment axis the same way**, through
`garmentPatchForCategoryChange(current, next)` in `src/lib/garment-mapping.ts`.
It returns `null` on a same-family change and a full patch otherwise —
**including one made of nulls** when the new category is not garment-graded, so
callers must spread the result rather than filter nulls out.

> [!note] The manual route was missing this until 2026-08-01 (US-2384)
> Changing the coarse category by hand wrote `item_category` alone, so a
> clothing → shoes correction still graded as clothing. Readiness could not catch
> it: both garment fields were populated, just wrong. The manual half had lived
> on `item-canvas.tsx` and went with the file.
>
> `categoryTouched` was doing two jobs — correctly stopping the eBay-path
> derivation from overwriting a manual pick, and incidentally suppressing the
> garment derivation as well. The shared helper is what stops the two routes
> drifting again; a test asserts they agree.

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
back recovers them.

> [!warning] The confirm dialog is gone (owner decision, 2026-08-03)
> US-824 held a category change behind an AlertDialog whenever specifics would
> not carry over. It is deleted, and a **toast** reports what was set aside
> instead. Two reasons, and the second is the one that matters if anyone
> proposes bringing it back:
>
> 1. It priced a non-loss as a loss. Parking is recoverable, and a blocking
>    confirm is the weight of "about to delete your work".
> 2. **It broke the change it was gating.** `AlertDialogAction` closes the
>    dialog when clicked; closing fired `onOpenChange(false)`; that ran the
>    same `cancelDiscard()` Escape uses, which reverted `categoryId` to the
>    category being replaced. On an item with no saved category that value is
>    `null` — so confirming a change blanked the picker to its search box and
>    the new category's specifics never appeared. Re-picking "fixed" it,
>    because by then `appliedCategoryRef` matched and no dialog opened to undo
>    the choice, which is why it read as flaky rather than broken.
>
> Pinned by `src/components/flipdesk/__tests__/category-discard-confirm.test.ts`.

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
