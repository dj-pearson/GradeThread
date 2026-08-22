# Shipping Truth: predict the parcel from the garment we already measured

**Status:** design approved, not yet storied
**Date:** 2026-08-21
**Scope:** predict shipping cost and parcel spec. Buying labels is out of scope and already exists.

## Summary

GradeThread measures every garment it grades. Nothing in the app uses those
measurements to predict what the garment will cost to ship. As a result the
profit estimate a seller prices against assumes shipping is free, the eBay
draft never carries a package weight, and the seller retypes a parcel weight by
hand on every single sale.

This adds one pure function that turns an inventory item into a predicted
parcel (weight, box, billable weight, estimated postage) and wires it into the
three places that already needed the number and did without it.

No carrier accounts. No money movement. No new marketplace integration.

## The defect this fixes

The margin floor is wrong today, and it is wrong in the direction that costs
money.

- `src/lib/listing-profit.ts:25` declares `shippingCost?: number | null`,
  documented as "Seller-paid shipping label, if known". It is almost never
  known.
- `src/pages/flipdesk/composer.tsx:2669` passes `shippingCost: item.shipping_cost`,
  a field the seller types by hand. Usually null.
- `src/pages/flipdesk/autolister-drafts.tsx:260` and `:578` pass no shipping at
  all.
- `src/pages/flipdesk/autolister-bulk-edit.tsx:467` passes no shipping to
  `priceForMargin`.

That last one is the live damage. A seller selects 40 drafts, clicks "floor at
30% margin", and every price is computed as if postage were zero. On a wool
coat that floor is not a 30% margin. It is a loss, applied in bulk, silently.

Two smaller gaps follow from the same missing number:

- `packageWeightAndSize` is never sent to eBay. `flipdesk-ebay.ts` attaches a
  fulfillment policy and nothing else, so calculated shipping cannot work from
  a GradeThread draft.
- `flipdesk-logistics.ts:366` builds its parcel from `parseParcel(body)`. The
  weight and dimensions arrive from the client because the seller entered them,
  once per sale, forever.

## What is already built (do not rebuild)

Checked before designing, because the first draft of this spec assumed
otherwise:

- **eBay label buying exists.** `services/edge-functions/src/routes/flipdesk-logistics.ts`
  (US-2160) prices rates, buys a label, reprints it, and voids it. It records
  the real cost.
- **Actual label cost already flows back.** The payout sync at
  `flipdesk-ebay.ts:3851` writes eBay's label cost into `sales.shipping_cost`,
  preferring it over anything the seller typed.
- **Fee math exists.** `src/lib/ebay-fees.ts` and `src/lib/ebay-fee-schedule.ts`.

The second of those is what makes the feedback loop in this design cheap: the
ground truth is already being collected.

## Out of scope

- Buying labels for non-eBay sales. eBay sales get eBay's negotiated rates
  through the existing route, and those beat a small third-party account. The
  no-API marketplaces are a separate question and are not answered here.
- Telling the seller which packaging to buy. This predicts the cost of the
  mailer they used.
- Adopting the unused `shipments` table (migration `00002`). Label data lives
  on `sales` and should keep living there. `shipments` stays unused; a comment
  in the spec is cheaper than a migration nobody needs.

## Design

### The estimator

One pure function, no network, no AI:

```
estimateParcel(item) -> {
  weightOz,          // predicted actual weight, packaging included
  billableWeightOz,  // max(actual, dimensional) for services that bill on size
  pack,              // mailer or box, with dimensions
  confidence,        // "good" | "rough"
  basis,             // which inputs were used, for the UI and for debugging
}
```

Deterministic is a requirement, not a preference. It runs on every keystroke in
the composer, it has to give the same answer twice, and it has to be
regression-tested against real shipments once they accumulate. An AI call is
none of those things.

### Weight model

Four terms, applied in order:

1. **Base weight by `garment_category`.** The enum already has 21 values,
   `t-shirt` through `gloves`. Each gets a base weight at a reference size.
2. **Size adjustment from `measurements`.** The item already carries chest,
   waist, length, sleeve and inseam. A 26 inch chest tee and a 46 inch chest tee
   are not the same parcel. When measurements are absent, fall back to the size
   label; when that is absent too, no adjustment and the confidence drops.
3. **Material adjustment from `material`.** Denim, leather, wool and corduroy
   run heavy. Poly, silk and rayon run light. A multiplier keyed off a
   normalized material string, with 1.0 for anything unrecognized.
4. **Packaging.** The mailer or box weighs something and it is not zero.

### Pack model and dimensional weight

Category picks a pack (poly mailer sizes, or a box for footwear and anything
rigid), and the pack gives dimensions. Dimensions give dimensional weight.

The bulky-and-light case is where sellers lose the most money and see it the
least. A puffer jacket weighs almost nothing and bills like a brick. Billable
weight is `max(actual, dimensional)` and the UI says which one won when they
disagree.

### Rate table

A versioned table with a real effective date, following the discipline in
`src/lib/ebay-fee-schedule.ts`.

Two rules copied from that file, because they were learned the hard way:

- **Nothing in the rate table may be edited from memory or a secondary source.**
  Every number gets read off the carrier's own published rates, and the working
  gets recorded alongside it.
- **Do not invent a freshness stamp.** USPS does publish effective dates, so a
  real `effectiveFrom` is correct here. That is the difference from the fee
  schedule, where no such date exists and inventing one was refused.

### Zone, and being honest about it

A label's price depends on how far the parcel travels. At listing time there is
no buyer, so there is no destination, so there is no true price.

The pre-list estimate uses a representative zone and the UI says "est." and
means it. It is a number for making a pricing decision, not a number for
accounting. Accounting already has the real figure from the payout sync.

### Confidence

- Measurements and material both present: show a number.
- Category only: show a range.

A precise-looking number derived from one input is a lie with a decimal point
in it. The estimator returns its `basis` so the UI can render the difference
rather than guess at it.

## Integration points

All three are edits to code that already exists.

1. **`src/lib/listing-profit.ts`** takes the estimate as its `shippingCost`.
   Fixes the composer, the drafts list, and the bulk margin floor. This is the
   defect fix, and it is the reason to ship first.
2. **eBay publish** sends `packageWeightAndSize` from the predicted parcel.
   Calculated shipping starts working from GradeThread drafts.
3. **`flipdesk-logistics.ts` rates route** pre-fills the parcel. The seller
   confirms or corrects a number instead of inventing one. The route keeps
   accepting a client parcel, because the seller correcting us is the point.

## Feedback loop

Store what was predicted at the time a label is bought. The real cost is
already written to `sales.shipping_cost` by the payout sync. Predicted against
actual, grouped by `garment_category`, is then a straight comparison.

Concretely, that is one nullable jsonb column on `sales` holding the estimator
output and its table version, written by the rates route when it pre-fills the
parcel. Not a new table: the row it belongs to already exists, the comparison
is always per sale, and the estimator version has to travel with the prediction
or the correction cannot be attributed to the table that made it.

That comparison is what turns the seeded v1 table into a measured one. It is
also the part no competitor can copy: it needs the garment measurements and the
shipment outcomes together, and nobody else has both.

A seller correcting the pre-filled parcel in the rates route is a second,
faster signal, and it arrives before the label is even bought.

## Testing

- The estimator is pure, so it gets unit tests against a fixture set of real
  garments with known shipped weights.
- The rate table gets its own tests, including the band boundaries. Being one
  ounce over a break is the case that matters.
- **A regression test for the margin floor that fails against today's code.**
  If it passes before the fix, it is not testing the defect.
- Dimensional weight gets an explicit puffer-jacket case.

## Rollout

The estimate ships as read-only advice first. It renders, it warns, and it does
not price anything automatically.

Auto-pricing off the estimate waits until the predicted-versus-actual data says
the table is honest, per category. The rate-break warning ("trim half an ounce,
save $1.85") is advice from day one and does not need to wait, because the
seller decides.

## Decisions made

- **Lookup table, not AI.** Determinism, zero cost per keystroke, and
  testability against real shipments.
- **Predict only, do not buy.** Buying exists for eBay and works. The gap was
  never the purchase, it was that nobody knew the weight before the sale.
- **Leave `shipments` unused.** Adopting a table nobody writes to would be
  motion, not progress.
- **Representative zone, labelled as an estimate.** The alternative is refusing
  to show a number at all, which leaves the margin floor broken.

## Open questions

- Which carrier services to model in v1. USPS Ground Advantage and Priority
  cover most apparel; UPS matters for heavy outerwear. Recommend starting with
  the two USPS services and adding UPS once the feedback loop has data.
- Where the v1 base weights come from. They will be seeded estimates with a
  stated tolerance, and the spec should not pretend otherwise. The feedback
  loop is the plan for making them real.
