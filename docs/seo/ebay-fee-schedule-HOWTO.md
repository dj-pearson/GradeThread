# Filling in the eBay fee sheet

`docs/seo/ebay-fee-schedule-to-confirm.csv` has 27 rows and one empty column,
`your_value`. Fill it and US-9003 through US-9006 unblock. Nothing else is
waiting on you.

Everything below is on eBay's own site. Use those pages, not a fee-calculator
blog: the calculators that come up in search disagree with each other, and one
of them is what put the possibly-stale 13.25% in this sheet in the first place.

## Where each block of rows lives

**Final value fees and the per-order fee** — Seller Center, "Selling fees". The
category table is the one to read: find "Clothing, Shoes & Accessories" and copy
the percentage exactly. Check three things while you are there:

- whether there is still a reduced rate on the portion of a sale above a
  threshold, and what the threshold is,
- whether Handbags & Wallets is broken out at its own rate,
- whether the athletic-shoe rate over $150 is still 8%. Second-hand sources say
  it requires BOTH the listing price and the sale total to clear $150, and that
  it carries no per-order fee at all. If that is right, the sheet is missing a
  row and the calculator has to model it.

**Insertion fees and free listings per month** — the store subscription
comparison page. The free-listing allowance differs per tier, and Starter may be
fixed-price listings only.

**Store subscription costs** — same page. Take the annual-billing column, which
is what the sheet asks for, and note if the monthly-billing price differs enough
to matter.

**International and currency fees** — the same selling-fees page, further down.
Worth confirming whether the international fee applies to a US seller shipping
to a US buyer who happens to be registered abroad, because that is the case
resellers actually hit.

**The Below Standard surcharge and any regulatory operating fee** — these come
and go by market. If a row no longer exists, write `n/a` rather than leaving it
blank, so the difference between "checked, gone" and "not checked" is visible.

## The one row no page can answer

`promoted_listings_standard_typical` is what **you** actually pay in ad rate on
apparel. Look at your own Promoted Listings report and put in the number you
really run at, not the one eBay suggests. This is the field that makes the
calculator's "what you actually clear" line honest, and a made-up default is
worse than leaving it out.

## When you are done

Add the date the schedule takes effect in the last row. The page states it, so
a stale result is visible to the reader rather than silently wrong.
