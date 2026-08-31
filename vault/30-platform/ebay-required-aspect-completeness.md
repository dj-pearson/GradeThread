---
title: eBay required-aspect completeness on publish and revise
aliases: [Department is missing, revise parity, required aspects]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/ai-listing.ts
  - services/edge-functions/src/lib/aspect-registry.ts
  - services/edge-functions/src/lib/aspect-provenance.ts
  - src/lib/aspect-provenance.ts
  - src/test/fixtures/required-aspects-cases.json
reviewed: 2026-08-31
tags: [ebay, publishing, aspects, gotcha]
summary: Publish fills required item specifics the stored override lacks; revise did not, so listings published fine and then failed every later revise.
---

# eBay required-aspect completeness on publish and revise

> **Re-reviewed 2026-08-31.** Drift flagged `ai-listing.ts` for `1ec50c48c`
> (US-3031), the condition-versus-category settlement described in
> [[ebay-description-freshness]]'s callout of the same date. It touches the
> condition field only. Re-verified while here: the aspect pipeline this note
> describes still enters through the same five modules `ai-listing.ts` imports
> at `:22` to `:91` — `aspect-registry`, `aspect-provenance`, `aspect-priority`
> and `aspect-reconcile` — none of which that commit edits.

> **Re-reviewed 2026-08-28.** Drift flagged both refs, for two commits that
> leave aspects alone. US-2974 adds an `item_id` to the comps search and stamps
> the comp stage for rewards. US-2967 moves a listing template's boilerplate
> into `description_blocks` so it is written by the same upsert that renders
> them, rather than appended by a follow-up UPDATE. Neither reads or writes an
> item specific, and the gap-fill this note describes on publish and revise is
> unchanged.

> **Re-reviewed 2026-08-17.** Drift flagged `flipdesk-ebay.ts` for `edd76704`
> (keep what eBay actually said about a listing) and `b25e7650` (relist
> verifies instead of infers). Both are about reading eBay's RESPONSE; neither
> changes which aspects are sent. The gap-fill rule — publish fills required
> specifics the stored override lacks, and revise must do the same — stands.

**Any path that sends aspects to eBay must complete them the same way.** Publish
and revise are two paths, and for a while only one of them did.

## The two-stage fill

Sending a listing's item specifics is two distinct steps, and they cover
different aspects:

1. **`forceColumnAspects`** re-asserts the five structured columns — Brand, Size,
   Color, Material, Style — over whatever the stored override holds, so a column
   edited on the item page wins over a stale specific. See
   [[sync-source-of-truth]] for which field owns what.
2. **`deriveAspectsFromItem` → `resolveItemAspects`** fills everything the
   columns do *not* own: the attribute-backed and inferred required specifics
   such as `Department` and `Size Type`. `Department` in particular is inferred
   by `inferDepartment` reading the item's own title, style, description,
   condition notes and size text (five fields, not three).

Step 2 never overwrites a value that is already set, so running it is safe on any
path.

## The defect this note exists to prevent

Revise ran step 1 only. A listing whose stored override was missing an
attribute-backed required aspect therefore **published successfully** — publish
filled the gap — and then **failed every subsequent revise** with eBay's raw
`A user error has occurred. The item specific Department is missing.`

The seller sees a listing that went live and now refuses every edit, with an
error naming a field they never touched. Fixed 2026-07-22: revise runs the same
resolver, records `inventory_derived` provenance for whatever it filled, and
**pre-flights `requiredMissingAspects` to return a 422 naming the missing
aspects** rather than paying an eBay round trip for a vague rejection.

`requiredMissingAspects` lives in the edge `aspect-provenance.ts`. The
composer's pre-publish checklist applies the SAME RULE — but not the same
function. It is a separate copy, `requiredMissingAspectNames` in the web
`src/lib/aspect-provenance.ts` (reached through `ebay-category-picker.tsx`),
because the two projects cannot import across each other.

> [!warning] "Cannot disagree" was wrong, and they already had (US-2389)
> This section used to say the checklist and the blocker were the same helper
> and so could not disagree. Two copies can always disagree, and when a shared
> fixture was finally pointed at them the web copy **threw a TypeError** on an
> aspect spec with no `aspectConstraint` object, where the edge copy returned
> safely. `EbayAspect` declares that field required, so the compiler said the
> case was impossible — but the value arrives from eBay's Taxonomy API at
> runtime, where a type is a claim about a remote payload, not a guarantee.
>
> The failure mode is quiet, which is why it earns a fixture rather than a
> comment: if the checklist says a listing is ready and the blocker refuses it,
> the seller has no way to find out what is wrong — the one surface that would
> tell them is the surface asserting nothing is missing.
>
> Both are now asserted against `src/test/fixtures/required-aspects-cases.json`
> and both are registered in the lockstep registry. Same remedy as the
> weighted-overall mirrors ([[weighted-overall-lockstep]]).

## Generation is now a third path (US-2423)

Publish and revise were the only two callers of `resolveItemAspects`. That meant
the attribute-backed specifics the extract pass had already read — pattern, fit,
neckline, and after US-2421 another two dozen — reached eBay but never reached
the **draft**. A seller opening a fresh AutoLister draft saw blank fields the
system already knew the answer to, and retyped them.

`generateListing` (`ai-listing.ts`, step 6c-bis) now runs the same resolver after
the aspect refine pass and before `reconcileGeneratedAspects`. Same contract as
the other two paths: fill-only, never overwrites, and whatever it fills is
recorded as `inventory_derived` so a later manual edit still wins.

The point to hold on to: **there are three paths now, and any fourth must fill
the same way.** The reason revise broke in the first place was that it did not.

> [!note] The fourth path arrived and did not repeat it (US-2395, 2026-08-15)
> The multi-variation group revise is a fourth caller, and it fills correctly by
> construction rather than by remembering to: `reviseVariationGroup` is handed
> the SAME `reviseWireAspects` the single-offer re-PUT sends, computed once
> above it, and writes each variant's own variation values over the top. A
> second assembly for the group is exactly how this note's original defect would
> have come back, so there isn't one.

## `requiredMissingAspects` has two more callers (US-2424, US-2425)

It is no longer only the publish blocker. Both new uses are read-only — neither
sends anything to eBay — but both now depend on it being right:

- **Category choice.** `generateListing` scores the top few Taxonomy suggestions
  by how many of each leaf's required aspects the item can already fill, and
  takes the best instead of `suggestions[0]`. eBay's own suggestion order is the
  tie-break, so a single candidate behaves exactly as it did before.
- **The coverage metric.** Every generated draft records `listings.aspect_coverage`
  — required and recommended tiers scored separately, because a required gap
  blocks the publish and a recommended one only costs search placement. The
  operator view is `/admin/listing-coverage`.

## Inference has a floor

`inferDepartment` only fires when the item's own text carries a gender OR AGE
token — the women/men variants, plus maternity, unisex, and the age words
(baby, infant, newborn, toddler, onesie, boys, girls, kids, youth, juniors,
children, child). A title like *"Maeve The Collette Black Wide Leg
Cropped Pants"* carries none, so `Department` must come from
`attributes.department` or be typed into the specifics editor. That is why the
specifics editor and the item fields have to live in the same editor
(`src/pages/flipdesk/composer.tsx` is the only item editor) — a seller told
"Department is missing" needs one obvious place to supply it.

> [!note] The precedence is one exported helper now (US-2796, 2026-08-23)
> This section describes two sources for `Department` — the stated
> `attributes.department`, and `inferDepartment` reading the item's own text
> — and the order between them mattered in a second place: the parcel
> estimator needs the department to decide whether a shoe's stamped number is
> a US men's or US women's size.
>
> That caller read only the INFERRED half, so an item whose capture pass had
> already written `department: "Women"` was re-derived from its title, and a
> title reading "Men's" overrode the stored value outright.
>
> `resolveDepartment(item)` in `aspect-registry.ts` is that precedence lifted
> out of `canonicalValues` — stated first, inferred as the fallback. It is not
> a new rule and it does not change what the aspect resolver fills; it exists
> so a caller outside the resolver cannot invent a second order. A test walks
> six items through both paths and asserts they agree, including the case
> where the stated value and the title disagree.

## Re-categorising a LIVE listing is a three-step swap, not a two-step one

Changing the eBay leaf on a listing that is already published cannot be pushed
as "new specifics, then new category" — the obvious order, and the one the
revise route did until 2026-08-05. eBay judges each call against the state it
holds *right now*, and neither end of the swap is legal alone:

- **Specifics first** are judged by the **OLD** category. A Dresses → Women's
  Tops correction sends a map with no `Dress Length`, so eBay answers *"The item
  specific Dress Length is missing"* — about an aspect the new category does not
  have. The route returns on that error **before** the offer PUT that carries the
  category, so the listing can never leave the wrong category from here. Every
  retry fails identically.
- **Category first** is judged by the **OLD** specifics. The live item has no
  `Type` (required on Tops), so eBay answers *"The item specific Type is
  missing"*.

The bridge: PUT the **union** of what eBay already holds
(`getInventoryItemAspects`) and what we are about to send — that satisfies both
categories' required aspects at once — then move the offer's `categoryId`, then
let the normal re-PUT drop the leftovers under the new category. It runs only
when the live offer's category actually differs, and it is best-effort: any
failure falls through to the unchanged path and its error handling.

Symptom to recognise: the GradeThread row and the composer both show the new
category, the seller has already fixed the title, and eBay's public listing page
still shows the **old** breadcrumb and the old required specific. Check the live
page, not the database — the database was never the thing that was wrong.

> [!warning] The bridge existed and the listing still could not be pushed (2026-08-08)
> A live listing re-categorised Dresses → Tops failed every push with *"The item
> specific Dress Length is missing"* for three days **after** this bridge
> shipped. Three separate defects, and the shape of each is worth more than the
> fix:
>
> 1. **The Retry button could not carry a category.** The failed-push banner's
>    retry (`src/pages/flipdesk/item.tsx`) sent `photos: true` and nothing else.
>    `photos` re-PUTs the inventory item; the leaf category lives on the
>    **offer**, and only `resync_ebay_fields` moves it or runs this bridge. So
>    the one control offered next to the error was structurally incapable of
>    fixing the error's most common cause, and every click failed identically.
>    A recovery affordance that cannot reach the failing field is worse than no
>    affordance — it reads as "we tried, it is unfixable".
> 2. **The bridge skipped itself when eBay reported no category.** The guard was
>    `liveCategoryId && liveCategoryId !== reviseCategoryId`, so a `getOffer`
>    response without `categoryId` fell through to the unchanged path — the same
>    outcome as not having the bridge, reached silently. It is now
>    `liveCategoryId !== reviseCategoryId`: *unknown* belongs with *different*,
>    because the cost of bridging unnecessarily is one superset PUT the normal
>    re-PUT immediately narrows.
> 3. **The bridge swallowed its own failure.** "Best-effort, falls through to
>    the existing error handling" meant the seller was shown the *downstream*
>    rejection — an aspect their category does not have — with nothing recording
>    which step actually broke. Neither the seller nor an engineer reading the
>    row could tell the bridge had even run. The reason is now carried into the
>    422 (`category_bridge_error`) and into `publish_error`.
>
> The through-line: **a fallback that hides why it fell back turns a diagnosable
> failure into an unfixable one.** Best-effort is about control flow, not about
> observability.

## The escape hatch was broken in the same place

The seller's instinct when a live listing will not change category is: end it,
fix it, relist. That path failed too, and reported success while doing it — see
[[ebay-listing-lifecycle-reconciliation]] § *A listingId is not a pulse*. Worth
knowing together, because it is what a seller reaches for when this section's
bridge lets them down.

## Two required aspects had no field behind them (US-3016, 2026-08-30)

Measured rather than reasoned about: `scripts/aspect-value-coverage.ts
--coverage` reads `ebay_category_aspects` back and asks, per aspect, whether
any registry entry can fill it. Across 121 cached categories it found 468
required aspects, and two of the gaps were structural rather than incidental.

**`Type`, required in 36 categories, was unfillable in 33 of them.** Not an
oversight. The style column lists `["Style", "Type"]` and `ownedAspectName`
binds each entry to exactly ONE aspect — deliberately, because one column
writing two aspects is the defect that made Type uneditable on Women's Tops.
So wherever a category exposes both names, Style wins and Type is left to the
refine pass, on a field whose absence blocks the publish outright.

Nothing captured answered it either: `style` is the marketing style name
(Sheath, Trucker), `product_line` is the family (501, Dri-FIT). Neither is a
Blouse. The `product_type` canonical key is that missing answer, mapped to
`["Type"]`. It is ATTRIBUTE-sourced on purpose — `garment_category` is a
Postgres enum column, and a column entry would reach `reverseColumnAspects`,
so a seller typing "Cardigan" into that specific would write an out-of-enum
value and 500 the save.

This is also what the re-categorisation section above is describing when it
says *"the live item has no `Type` (required on Tops)"*. That bridge is still
needed — it solves a live-listing ordering problem, not a fill problem — but
the underlying blank it was routing around is now filled at source.

**`Country of Origin` was mapped to two names that exist nowhere.** The
`country_of_manufacture` entry targeted "Country/Region of Manufacture" and
"Country of Manufacture". Neither appears in ANY of the 121 cached
categories. eBay calls it **Country of Origin**, present in all 121 and
SELECTION_ONLY. A value read verbatim off the care label had no aspect to
land on, on every listing ever published, and nothing reported it because a
candidate matching no aspect is indistinguishable from a category that does
not have the field. The real names now lead the list; the old spellings are
kept behind them for other marketplaces.

> [!note] The same run corrected a value-side cap, see [[ebay-aspect-value-limit]]
> Country of Origin ships 244 allowed values against a 150-value enum cap, so
> the model was handed a menu missing most of the late alphabet — Vietnam,
> Thailand, Turkey, Taiwan, Sri Lanka, Portugal, Philippines, Pakistan,
> Romania, Tunisia, United States. Raised to 300. Fixing the name without the
> cap would have landed the aspect on a list that could not hold the answer.

**The remaining six are genuinely thin, not structural**: Outer Shell Material
(6 categories), Insect Repellent Treated (3), Inseam (2), Exterior Color (1),
Exterior Material (1), Game (1). Each is reachable by the refine pass, which
is always asked about every required aspect, so "no registry entry" is not
the same as "ships empty". What would settle it is a fill-rate query over
live `inventory_items.ebay_aspects`, which has not been run.

Scope for non-apparel categories is [[adr-flipdesk-universal-gradethread-garments]].
## Related

- [[sync-source-of-truth]] — which field owns which specific
- [[ebay-aspect-value-limit]] — the other publish-time aspect rejection
- [[ebay-condition-and-policies]] — the condition equivalent of this parity rule
- [[INDEX]]
