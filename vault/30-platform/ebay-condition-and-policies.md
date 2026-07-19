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
reviewed: 2026-07-19
tags: [ebay, publishing, conditions, gotcha]
summary: Condition validation lives on the Sell Metadata API, not Taxonomy, and apparel rejects LIKE_NEW — both failures are silent until publish.
---

# eBay condition mapping and the policy endpoint

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

Condition enums are **per-category**, and clothing does not accept `LIKE_NEW`.
The additions that cover the real cases:

| Enum | eBay id | Means |
|---|---|---|
| `NEW_OTHER` | 1500 | New without tags |
| `NEW_WITH_DEFECTS` | — | New with defects |

`remapConditionForCategory` picks a condition the target category actually
accepts. Its rule is **never overstate**: when the mapped-to condition would
claim better condition than the grade supports, it steps down rather than up.
That constraint is deliberate — overstating condition on a graded garment
contradicts the certificate and is a refund and trust problem, not a listing
inconvenience.

The remap runs at **both publish and revise**. A revise path that skipped it
would silently re-introduce a rejected condition on an existing listing.

## Related

- [[ebay-aspect-value-limit]] — the other publish-time rejection, also deferred
- [[grading-scale-and-weights]] — the grade a condition must not overstate
- [[cross-listing]] — which marketplaces are reached by API at all
- [[INDEX]]
