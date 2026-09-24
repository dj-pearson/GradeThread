---
title: A marketplace's price field has its own units, and ours are not always them
aliases: [priceStep, whole dollars, Poshmark cents, marketplacePriceString]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/marketplace-price.ts
  - services/edge-functions/src/lib/marketplace-price.ts
  - src/lib/marketplace-specs.ts
  - services/edge-functions/src/lib/cross-listing-fields.ts
  - supabase/migrations/00806_repair_whole_dollar_listing_prices.sql
  - scripts/diagnose-whole-dollar-price-drift.mjs
reviewed: 2026-09-24
tags: [platform, marketplace, money, crosslisting, poshmark, vinted]
summary: FlipDesk holds money as dollars; Poshmark and Vinted price in whole dollars and their input refuses a decimal point, so one rule (stepPriceCents) converts at the boundary, MarketplaceSpec.priceStep is the only place that knows which marketplace needs it, and 00806 repairs the rows written before either existed.
---

# A marketplace's price field has its own units

Reached from [[moc-platform]]. The units half of [[cross-listing]].

## The boundary

FlipDesk holds money as **dollars**: `listings.listing_price` and
`platform_fields[platform].price` are both numeric dollar amounts. A
marketplace's price input has its own units.

Poshmark's listing-price input is `inputmode="numeric" pattern="[0-9]*"` -
digits only, no decimal point - because Poshmark prices in **whole dollars**.
`"32.49"` is not a value that field can hold. Vinted is the same.

The boundary is the moment a FlipDesk number becomes the keystrokes the
extension types. Everything crossing it goes through one file, mirrored
token-for-token between the SPA and the edge because they share no module
graph:

| Function | Used by |
|---|---|
| `marketplacePriceString` | both builders of the extension `list` payload |
| `stepPrice` | the revise payload and the Listing Kit row |
| `stepPriceCents` | the integer-cents core both of those call |

## The rule

`stepPriceCents(priceCents, stepCents)` rounds to the **nearest** whole step
and never lands **below one step**.

- **Nearest, not floored.** Flooring quietly costs the seller money on every
  cross-post, and the stepped number is shown in the Listing Kit row before
  they send it, so it is a visible change rather than a silent one.
- **Never below one step.** A 40-cent item becomes $1, never $0. Poshmark's
  minimum is $1.00, so $0.40 is not a rounding error - it is a price that
  cannot exist.
- **In integer cents.** `Math.round(dollars / step) * step` on floats produces
  `32.450000000000003`, which is a string no numeric input will take.
- **Guarded against a nonsense step.** An `Infinity` step made
  `Math.round(price / step)` zero and `0 * Infinity` NaN, so a bad step turned
  a real price into NaN and put that on the row. Found by writing the test.

## Who needs it

`MarketplaceSpec.priceStep` in `src/lib/marketplace-specs.ts` is the **only**
place that knows which marketplace has which units, because it is a fact about
the MARKETPLACE and not about our adapter for it.

- `poshmark` and `vinted` declare `priceStep: 1`, both confirmed against a
  live form.
- `depop` has no `priceStep` and **the absence is deliberate**, with its reason
  in the registry.
- `mercari`, `grailed` and `facebook` declare none and give no reason. All
  three plausibly price in whole dollars and **none is confirmed**. Guessing
  one is the mistake this area's history already records, so confirming them
  is a probe task rather than a code change.

## The rows written before the rule existed

Until US-2736 and US-2739, every non-eBay channel was priced from the shared
eBay number with **no rounding**, so a sibling row recorded `32.49` for a
listing Poshmark can only hold at `32`, and a 40-cent item was recorded at
`0.40`. Those stories fixed what the extension TYPES and what a new push
RECORDS. Neither repaired a row already written, and the row is what profit,
payout reconciliation and the revise price all read - so the revise path would
have typed the stored number back at the marketplace.

`00806` is the repair, and it is the only migration in this area that rewrites
seller money:

- `listing_price` and `platform_fields[platform].price` (plus `price_override`
  where a row has one) move **together, in one statement set**. A row whose two
  copies disagree is worse than one that is merely wrong.
- Only `poshmark` and `vinted`. `src/test/whole-dollar-price-repair.test.ts`
  fails if the registry's `priceStep` set changes and the migration does not.
- It **reports** its row counts through `RAISE NOTICE` rather than succeeding
  silently, because a no-op and a success read identically in a psql
  transcript.
- `scripts/diagnose-whole-dollar-price-drift.mjs` is the read that goes first.
  It counts per platform and separates rows **below the floor** from rows
  merely carrying cents, and it imports `stepPriceCents` rather than
  reimplementing it.

⚠ The blob is written with `round(..., 2)`. Without it the numeric division
carries its full scale into the JSON and the repaired row reads
`{"price": 32.0000000000000000}` where the application writes `{"price": 32}`.
Numerically identical, and still the wrong thing to leave in a column a person
reads.

## Related

- [[cross-listing]] - how a sibling row gets a price in the first place.
- [[sync-source-of-truth]] - who owns `listings.listing_price` when two
  clients disagree.
