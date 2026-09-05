---
title: eBay condition mapping and the policy endpoint
aliases: [25021, condition mapping, LIKE_NEW]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ebay-client.ts
  - services/edge-functions/src/lib/ai-listing.ts
  - services/edge-functions/src/lib/publish-preflight.ts
reviewed: 2026-09-05
tags: [ebay, publishing, conditions, gotcha]
summary: Condition validation lives on the Sell Metadata API, not Taxonomy, and apparel rejects LIKE_NEW — both failures are silent until publish.
---

# eBay condition mapping and the policy endpoint

> **Re-reviewed 2026-09-05.** Drift flagged `ai-listing.ts` for `f4d6a71d1`
> (US-3088, the anonymous listing-draft endpoint). Three changes, and none of
> them is about condition mapping or the policy endpoint: an optional `feature` slug on `ListingGenInput` so the
> free tool's spend lands in its own AI-ledger bucket, `enterAiFeature` reading
> it with `"autolister"` as the default so every existing caller stays put, and
> the photo content block going through `tagImageSource()` so a data URI is sent
> as base64 instead of being handed to the API as a URL. A plain https URL comes
> back from that sniff untouched, so the generation path is byte-identical.
>
> ⚠ Corrected while here: the 2026-08-28 callout below cites `EBAY_CONDITION_VALUES` at
> `ai-listing.ts:165-178`. It is at `:235` now and had already moved before this
> pass — the enum members and the apparel LIKE_NEW rejection are unchanged, only
> the line reference was stale.

> **Re-reviewed 2026-09-03.** Drift flagged `ebay-client.ts` for `57eff0f03`
> and `f9144c69a`. The first is `isOfferNotFoundError` (an absent offer is an
> empty list, not an error) and touches no condition or policy code. The second
> adds optional `conditionIds` (plural) and `buyingOptions` to the Browse comps
> search for US-3098 sourcing scans; when neither is given the filter string is
> still `conditionIds:{3000}` and all three buying options, character for
> character, so the comp-pricing callers' cached URLs are unchanged. The
> publish-side condition mapping and the policy endpoint did not move.

> **Re-reviewed 2026-09-02.** Drift flagged `ebay-client.ts` for the size
> enforcement work: a shorter category-aspect cache TTL (30 days to 7), a
> `{ fresh: true }` bypass and `invalidateCategoryAspects`. Conditions are not
> aspects and do not go through that cache -- `getItemConditionPolicies` reads
> the Sell Metadata API, which this note exists to say is a DIFFERENT endpoint
> from Taxonomy. Both claims below re-verified and unchanged.
>
> **Re-reviewed 2026-08-31.** Drift flagged `ebay-client.ts` for `fb9de8279`,
> the numeric-id coercion. One additive hunk at the end of the file adding
> `ebayId()`, used by the post-order modules; nothing in it reads or writes a
> condition. Re-verified both claims: `getItemConditionPolicies` is at
> `ebay-client.ts:1698` and still hits `/sell/metadata/v1/marketplace/...` at
> `:1731`, and the comment naming it a Sell Metadata rather than Taxonomy
> method is still at `:1723`.

> **Re-reviewed 2026-08-28.** Drift flagged `ai-listing.ts` for `a7551b251`
> (US-2959, generation writes description blocks instead of one prose string).
> That rewrote how the DESCRIPTION is assembled and moved a few hundred lines;
> it touches neither condition lookup. Re-verified both claims:
> `getItemConditionPolicies` still hits `/sell/metadata/v1/marketplace/...`
> (`ebay-client.ts:1732`), and the apparel enum list is still
> `EBAY_CONDITION_VALUES` at `ai-listing.ts:175-195` — the same members, moved
> down ten lines.

> **Re-reviewed 2026-08-23.** Drift flagged `ebay-client.ts` for `57fb8a64e`
> (the outgoing-offer email fix). Unrelated to conditions. Re-verified both
> claims this note exists for: `getItemConditionPolicies` still calls
> `/sell/metadata/v1/marketplace/...` (`ebay-client.ts:1646`) rather than
> Taxonomy, and the apparel LIKE_NEW rejection is still what
> `EBAY_CONDITION_VALUES` documents at `ai-listing.ts:165-178`, with
> NEW_OTHER and NEW_WITH_DEFECTS carrying the grade-9 NWOT tier instead.

> **Re-reviewed 2026-08-17.** Drift flagged `ebay-client.ts` for `b25e7650`
> (relist now checks eBay's answer rather than assuming it). Condition
> validation still lives on the Sell Metadata API rather than Taxonomy, and
> apparel still rejects LIKE_NEW; that commit touches neither lookup.

Two failures that both surface only at publish, long after the mistake.

## The policy endpoint is Metadata, not Taxonomy

`getItemConditionPolicies` is a **Sell Metadata API** method keyed by marketplace
id:

```
/sell/metadata/v1/marketplace/{marketplaceId}/get_item_condition_policies?filter=categoryIds:{...}
```

The Taxonomy-shaped path that looks right —
`/commerce/taxonomy/v1/category_tree/{treeId}/get_item_condition_policies` —
**does not exist and 404s**.

That is worse than an obvious error. The 404 silently disabled condition
validation entirely, so invalid conditions sailed through preflight and were
rejected by eBay at publish with **error 25021**. The guard was running, green,
and checking nothing — a failure mode worth recognising by name.

The response shape parsed in `ebay-client.ts`
(`itemConditionPolicies[].itemConditions[]`) is the Metadata API's, which
confirms the endpoint choice rather than assuming it.

## Apparel rejects `LIKE_NEW`

Condition enums are **per-category**, and clothing does not accept `LIKE_NEW`
(id 2750). The additions that cover the real cases:

| Enum | eBay id | Means |
|---|---|---|
| `NEW_OTHER` | 1500 | New without tags |
| `NEW_WITH_DEFECTS` | 1750 | New with defects |

The ids live in `CONDITION_ENUM_TO_ID` (`publish-preflight.ts`); the enum itself
is mirrored in four places that must move together — edge
`EBAY_CONDITION_VALUES`, web `EBAY_CONDITION_OPTIONS`, iOS `EbayCondition.swift`,
and that id map.

> [!warning] The iOS mirror is currently behind (found 2026-08-08)
> `EbayCondition.swift` jumps from `.likeNew` straight to `.usedExcellent`: it is
> missing `PRE_OWNED_EXCELLENT` (2990) and `PRE_OWNED_FAIR` (3010), which the
> other three mirrors carry. This is exactly the drift the four-places rule warns
> about, found by re-reading rather than by any test. Fixing it needs a macOS
> session — see [[blocked-work-gates]].

**The grade mapping was the actual bug.** `mapEbayCondition` sent the grade-9
new-without-tags tier to `LIKE_NEW`, and iOS even labelled `LIKE_NEW` as "New
without tags" in its picker — so the wrong enum was both produced and displayed
as if it were right. Grade ≥ 9 NWOT now maps to `NEW_OTHER`.

`remapConditionForCategory` picks a condition the target category actually
accepts. Its rule is **never overstate**: when the mapped-to condition would
claim better condition than the grade supports, it steps down rather than up.
That constraint is deliberate — overstating condition on a graded garment
contradicts the certificate and is a refund and trust problem, not a listing
inconvenience.

When no allowed condition is honest, the remap returns **null** and the caller
blocks the publish. Blocking is the correct outcome: there is no such thing as a
close-enough overstatement here.

The remap runs at **both publish and revise**. A revise path that skipped it
would silently re-introduce a rejected condition on an existing listing — the
same parity rule [[ebay-required-aspect-completeness]] enforces for aspects.

## The seller can always override

Auto-picking is a floor, not a verdict. A condition picker exists on the web
composer, the web quick-publish dialog and the iOS publish dialog; the chosen
value persists to `listings.ebay_condition` and is what the resolver starts
from. Adding a new publish entry point without a picker leaves sellers with no
way to correct a mapping they disagree with.

## Related

- [[ebay-aspect-value-limit]] — the other publish-time rejection, also deferred
- [[ebay-required-aspect-completeness]] — the same publish/revise parity rule for item specifics
- [[ebay-listing-lifecycle-reconciliation]] — what happens after eBay rejects or removes a listing
- [[grading-scale-and-weights]] — the grade a condition must not overstate
- [[cross-listing]] — which marketplaces are reached by API at all
- [[INDEX]]

## 2026-09-04: re-read after the US-3047 refine-pass change

`services/edge-functions/src/lib/ai-listing.ts` changed, and none of it
touches condition. US-3047 did three things there: the second-pass
`extractEbayAspects` call now bills the ledger under `autolister_refine`
instead of sharing `catalog_extract`; the photo-role vision pass is
skipped when every photo already carries a deliberate role; and that
pass's tokens and cost now land in the item's `ai_enrichment_log` row.
Cost accounting and one call-avoidance gate. Condition mapping, the
policy resolve and the honest-stand-in rule are all unchanged.
