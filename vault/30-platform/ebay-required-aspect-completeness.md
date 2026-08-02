---
title: eBay required-aspect completeness on publish and revise
aliases: [Department is missing, revise parity, required aspects]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/flipdesk-ebay.ts
  - services/edge-functions/src/lib/aspect-registry.ts
  - services/edge-functions/src/lib/aspect-provenance.ts
reviewed: 2026-08-01
tags: [ebay, publishing, aspects, gotcha]
summary: Publish fills required item specifics the stored override lacks; revise did not, so listings published fine and then failed every later revise.
---

# eBay required-aspect completeness on publish and revise

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
   by `inferDepartment` reading the item's own title, style and size text.

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

`requiredMissingAspects` lives in `aspect-provenance.ts` and is the same helper
the composer's pre-publish checklist uses, so the UI warning and the server
blocker cannot disagree.

## Inference has a floor

`inferDepartment` only fires when the item's own text carries a gender token —
"Women's", "Boys", "Men's". A title like *"Maeve The Collette Black Wide Leg
Cropped Pants"* carries none, so `Department` must come from
`attributes.department` or be typed into the specifics editor. That is why the
specifics editor and the item fields have to live in the same editor
(`src/pages/flipdesk/composer.tsx` is the only item editor) — a seller told
"Department is missing" needs one obvious place to supply it.

## Related

- [[sync-source-of-truth]] — which field owns which specific
- [[ebay-aspect-value-limit]] — the other publish-time aspect rejection
- [[ebay-condition-and-policies]] — the condition equivalent of this parity rule
- [[INDEX]]
