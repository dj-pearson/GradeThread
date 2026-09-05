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
  - src/lib/measurement-templates.ts
reviewed: 2026-09-04
tags: [flipdesk, grading, ebay, contract]
summary: An item carries three category axes that must agree; correcting one cascades into the others, and the specifics a change cannot carry are set aside rather than destroyed.
---

> **Re-reviewed 2026-08-30.** Drift flagged `src/lib/ebay-category-map.ts` for
> `c1b5a3ca7` — US-3016 teaching `ebayPathToItemCategory` to classify
> non-apparel from its ROOT segment. **This one DOES change the contract**, so
> §"The cascade" above was rewritten rather than merely re-read. Before it, a
> non-garment eBay path returned null and therefore cascaded nothing: pick "Toys
> & Hobbies" and `item_category` simply stayed as it was. Now the same pick
> returns `collectibles`, the cascade fires, and because `deriveGarmentType`
> maps non-garment categories to `null`, the family test sees a change and
> `garmentPatchForCategoryChange` re-derives the garment axis **to null** —
> clearing `garment_type`/`garment_category` on an item that had them. That is
> the intended behaviour (an item that is no longer a garment should not keep a
> garment rubric), and it is exactly why callers must SPREAD the patch rather
> than filter its nulls out. A whole class of path that used to be inert is now
> live, which is the sort of thing this note exists to say out loud.

> **Re-reviewed 2026-08-23.** Drift flagged `src/lib/ebay-prefill.ts` for
> `e28975d32` — US-2796's shoe-scale rule reaching the composer prefill. The
> measurement fold-in now passes the item's stated shoe-size scale, so a UK or EU
> number stops filling eBay's "US Shoe Size". **The cascade contract here is
> unaffected**: this changes which aspect NAME a shoe number may fill, and it
> reads `attributes.shoe_size_scale`, which is not one of the three category axes
> and does not participate in the cascade. Nothing about what a category change
> carries, sets aside or re-derives is touched — including §"What the
> measurements read", which is about `garmentDescriptorFor` choosing a TEMPLATE
> and is a different part of this file.

# Changing a category — what cascades, and what the seller keeps

> **Re-reviewed 2026-09-02, and one rule below is now stricter.** eBay began
> enforcing standard values for SIZE aspects (see [[ebay-standard-size-values]]),
> so `src/lib/aspect-normalize.ts` and its edge twin treat any aspect whose name
> contains "size" as a CLOSED LIST whenever the category publishes values for
> it, regardless of the `aspectMode` the cache holds. `src/lib/ebay-prefill.ts`
> and the category picker follow that, so a size aspect renders as a dropdown
> rather than a free-text box after a category change.
>
> This tightens, rather than contradicts, the parked-value rule further down:
> a size value that no longer exists in the new category is not merely parked,
> it is refused at publish by eBay itself, and the stored specific is refitted
> from fresh taxonomy before the retry.


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
(`src/lib/ebay-category-map.ts`) reverse-maps the chosen eBay path, and it reads
**two different parts of the path depending on the root** (US-3016):

- **Apparel** is classified from the **descendant** segments, because the root
  "Clothing, Shoes & Accessories" names three verticals at once and settles
  nothing.
- **Everything else** is classified from the **root** segment, in
  `rootVertical()`. Every non-apparel root — "Collectibles", "Antiques", "Toys
  & Hobbies", "Books" — names exactly one thing, and their descendants actively
  mislead: "Collectibles › Advertising › Shoes" is a tin sign and "Toys &
  Hobbies › Action Figures › Accessories" is a plastic sword. Running the
  apparel regexes over those tails would not be conservative, it would be wrong.
- **Two roots straddle our enum** and let the tail break the tie: "Jewelry &
  Watches" splits on the word *watch*, and "Sports Mem" splits cards from
  autographs.
- An **unrecognised root falls through to the descendant logic**, which is
  load-bearing rather than tidy: `category_name` in the aspect cache is not
  always a full root-first breadcrumb, and plenty of rows start at "Pants" or
  "Sweaters".

It still **returns null when unsure** rather than guessing. The composer then
writes `item_category` in the same save, plus
`garment_type`/`garment_category` — but **only when the coarse FAMILY changes**
(`deriveGarmentType(next) !== deriveGarmentType(current)`), so a same-family
correction keeps the seller's own garment pick.

That restraint is the point: the cascade exists to stop axes drifting apart, not
to overwrite deliberate choices.

> [!warning] The cascade can only be as right as the reverse map (US-2799)
> A worked instance of this note's own thesis. `ebayPathToItemCategory` had no
> `headwear` branch, and hats sat in the `accessories` one — so a seller who
> deliberately picked eBay's "Men's Hats" had `item_category` cascaded from
> headwear TO accessories, losing the rubric, the photo profile and the
> measurement template in the same save. The most explicit statement available
> about what an item is, translated into the wrong answer, by the mechanism
> built to keep the axes together.
>
> Two things made it survive. The branch order: eBay files hats under a
> Clothing parent on several paths, so both words sit in the tail and only
> ORDER decides which wins — headwear now sits with `shoes` and `bags` above
> `clothing`. And the test, which was titled "(belts/hats)" and asserted only
> belts, so its name claimed coverage the assertion never had.

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

### What the measurements read, and why it is not the cascade (US-2673)

The restraint above has a cost the cascade cannot pay: **two clothing categories
are the same family**, so correcting a draft from Women's Pants to Men's
Sweaters changes nothing on the garment axis and `garment_type` keeps whatever
it had. For grading criteria that restraint is right — the seller's garment pick
should survive. For the measurement template it left the seller staring at a
Chest field on a pair of jeans.

So the measurement surfaces do not read the garment axis directly. They call
`garmentDescriptorFor` (`src/lib/measurement-templates.ts`), which ranks every
garment word on the item and takes the best one:

1. **the eBay category LEAF** — the most deliberate statement on the row.
   Somebody picked it and eBay validated it, and the specifics editor already
   trusts it enough to ask for a waist and an inseam. **The leaf, never the
   path**: the path begins "Clothing, Shoes & Accessories", so a leaf naming no
   garment ("Athletic Apparel") would otherwise walk back up and match `shoes`.
2. `garment_category`, then `category`, then the title — anything specific.
3. **the six coarse GARMENT_TYPES values, LAST.** `deriveGarmentDefaults` writes
   `garment_type: "tops"` for ANY clothing item intake never classified, so that
   column reads "tops" on a pair of jeans as readily as on a t-shirt. It is a
   placeholder, not a classification, and it used to be consulted second. It
   still resolves when it is the only garment word on the row, which is the iOS
   case.

`EbayCategoryPicker` reports the breadcrumb through `onResolvedCategoryPath`,
which is deliberately NOT `onCategoryChange`: that one means "the seller changed
the category" and a save acts on it, so firing it for a reopened draft would
cascade the coarse category on load.

**Still true after this:** a category switch changes what you are ASKED to
measure. It does not rewrite `garment_type`, so grading still reads the old
value. Teaching `deriveGarmentDefaults` to read the title would change rubric
selection, which is gated behind the grading eval.

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

## 2026-09-04: syncedAspectNameFor, the inverse lookup

`src/lib/ebay-prefill.ts` gained `syncedAspectNameFor(column, category,
aspectList)` in 1d565ca6f: given a structured column, the ONE eBay
specific it is two-way synced with for that category. The inverse of
`syncedItemFieldFor`.

It matters to this note's cascade because of which candidate it picks. It
calls `ownedAspectName`, deliberately the same call
`reverseProjectAspectColumns` makes. A caller that writes a column and
this aspect together therefore writes the pair the next save reads back;
picking any other candidate the spec happens to list would mean the save
reverse-projects a different specific over the column and silently undoes
the seller's edit. Returns null when the category exposes no such
specific, which is the signal to write the column alone.

Additive. No existing remap or cascade behaviour changed.
