---
title: eBay standardized size values at publish
aliases: [custom values for Size Type, size enforcement, standard sizes]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/aspect-reconcile.ts
  - services/edge-functions/src/lib/ebay-size-enforcement.ts
  - services/edge-functions/src/lib/ebay-client.ts
  - services/edge-functions/scripts/refresh-ebay-aspect-cache.ts
  - src/lib/aspect-normalize.ts
reviewed: 2026-09-03
tags: [ebay, publishing, aspects, gotcha]
summary: eBay now rejects a custom Size or Size Type value at publish; the size aspects are treated as closed lists whatever the cached Taxonomy mode says, a rejection refetches the spec and repairs the draft on the spot, and the aspect cache lives seven days instead of thirty.
---

# eBay standardized size values at publish

> **Re-reviewed 2026-09-03.** Drift flagged `ebay-client.ts` for `57eff0f03`
> (the offer-absent 404 in `listOffersForSku`) and `f9144c69a` (the US-3098
> Browse sourcing filters). Neither is in the aspect or size neighbourhood:
> `aspect-reconcile.ts`, `ebay-size-enforcement.ts` and the aspect cache refresh
> script are untouched, and the Browse changes are search-side only.

## What eBay changed

eBay's developer notice (August 2026): Apparel and Footwear listings must use
eBay-supported size values, enforced site by site (France, Italy, Spain
2026-08-31; UK, Canada, Germany 2026-09-08; Australia 2026-09-15; United
States 2026-09-22; every MSKU listing 2026-10-20). A new or revised listing with
a custom value is refused:

> The product aspects for this category no longer support custom values for
> Size Type. Your listing was not published. Update your request to use our
> standard values for Size Type. Use getItemAspectsForCategory ...

Existing listings without a supported value are hidden until the Size field is
updated. The supported values come from `getItemAspectsForCategory` for the
leaf category and site; eBay says its own normalising ("Lrg" to "L") is limited
and must not be relied on.

## Why our publish broke on 2026-09-01

The Taxonomy payload for a category is read-through cached in
`ebay_category_aspects`, and until this change the cache lived 30 days. eBay
flipped Size and Size Type to closed lists without changing the aspect NAME,
and in the payloads we had cached the `aspectMode` still read `SUGGESTED`.
`reconcilePublishAspects` only refused a miss on a `SELECTION_ONLY` aspect, so
a custom value passed through to the Inventory API and eBay rejected it.

## The rules now

1. **The size family is a closed list whenever eBay ships values**, whatever
   mode the cached payload reports. `isSizeAspect` in `aspect-reconcile.ts`
   (any aspect whose name carries "size": Size, Size Type, US Shoe Size, Hat
   Size, Waist Size and so on) makes `isClosedList` true when the allowed list
   is non-empty. The normaliser is then called in `SELECTION_ONLY` mode, so a
   synonym is repaired ("Standard" to "Regular", "Large" to "L") and a miss is
   omitted and diagnosed rather than sent. A size aspect eBay shipped no values
   for still takes free text ("32x30" on a category with no Size list).
2. **A custom-value rejection heals itself.** `ebay-size-enforcement.ts` reads
   the aspect name off eBay's message, drops the category's cache row,
   refetches the spec, reconciles the stored specifics against it, persists the
   repaired map to the draft (the listing override, else the item), and returns
   the seller a sentence: what was changed and to what ("publish again"), or
   which value to pick from eBay's list. Wired into the publish catch and both
   revise catches in `flipdesk-ebay.ts`; the variation revise path is not yet.
3. **The aspect cache lives seven days**, not thirty (`ASPECT_TTL_MS`).
4. **The composer mirrors the rule.** `isClosedAspect` in
   `src/lib/aspect-normalize.ts` turns a size aspect with values into a dropdown
   in the category picker and a closed list in the prefill, so a seller cannot
   type a value the publish will drop.

## Operator step after deploying

Run `deno run --allow-net --allow-env --allow-read scripts/refresh-ebay-aspect-cache.ts`
from `services/edge-functions` with the edge's env so every cached category is
current on day one, and again on each site's enforcement date. `--dry` lists
what is cached without fetching.

## Not done

- Existing live listings with a custom size are hidden by eBay from each
  site's date. A sweep that finds live eBay rows whose Size / Size Type does
  not match the fresh list and revises them is the next piece; the revise
  path already reconciles, so the sweep is "revise every affected listing".
- The valid Size Type plus Size combination eBay mentions is not validated
  here; the Taxonomy payload does not describe combinations.

## Related

- [[ebay-required-aspect-completeness]]
- [[ebay-aspect-value-limit]]
