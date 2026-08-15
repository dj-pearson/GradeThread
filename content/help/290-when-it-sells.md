---
slug: when-it-sells
title: When it sells
category: flipdesk
visibility: public
audience: seller
sort_order: 100
pillar_path: /flipdesk
summary: What happens to the other channels when one copy sells, what the Sold status is waiting for, and why a pending delist is a reminder rather than a failure.
faq:
  - q: What stops me selling the same item twice?
    a: Automatic delisting where the channel supports it, and a loud pending-delist reminder where it does not. The reminder exists precisely because two channels cannot be automated.
  - q: Does the certificate stay live after it sells?
    a: Yes. The buyer has that link in their order history and it keeps working, which is the point of it.
---

A sale is the moment several things have to happen quickly and in the right
order. Most of them happen without you.

## The sale arrives

FlipDesk polls the connected channels for orders. When one lands, the item moves
to Sold, and it carries the buyer, the price actually paid and the channel.

eBay orders arrive through the official API, so they land reliably and quickly.
Sales on extension-listed channels are recorded when you mark them, because
without a seller API there is nothing to poll.

## The other copies come down

This is the part that matters most and the part cross-posting most often gets
wrong elsewhere. Selling one garment to two people is worse than never
cross-posting, because you owe somebody a refund and an apology and the
marketplace records the failure against you.

Where the channel supports automatic delisting, it happens: **Poshmark** and
**Mercari** both end the sibling listing without you.

Where it does not, you get a **pending delist**: a marker on the item and a
reminder naming the channel and the listing.

**Grailed** is a permanent no. Its delete is confirmed by a native browser
dialog that nothing running inside a page can answer, so it cannot be automated
by anything, ever, in this design. **Vinted** is not yet verified, which is a gap
rather than a wall.

Both stay in the reminder set precisely so the copy you have to end by hand is
the one you are told about every time, rather than the one you forget.

<!-- SCREENSHOT: an item at Sold showing a pending delist for Grailed -->

## The numbers land

The sale records what the buyer paid. It does not yet know what you received,
because the channel's fees, the postage and any promotion cost come off later.

That gap is what reconciliation closes, and it is why Sold and Completed are
different statuses. A sale is a thing that happened; a completed sale is a thing
you have been paid for and can count.

If you recorded what you paid for the item, this is the point where profit
becomes a real number instead of a guess. If you did not, it never does. That is
the argument for the cost field in
[Sourcing and adding items](/help/flipdesk/sourcing-and-adding-items).

## Next: ship it

The item's next action becomes "ship". Buy the label, add the tracking number,
and it moves to Shipped.

Do it promptly. Every marketplace measures dispatch time and most of them weight
search placement by it, so a slow handling time costs you on the next listing
rather than this one.

## The certificate outlives the sale

The certificate link stays live after the item sells. The buyer has it in their
order history, and a link that died at the moment of sale would be worse than
useless.

It is also the thing that settles a condition dispute later. A buyer claiming
the garment was not as described is arguing against a dated, public record of
its condition with the photos it was assessed from, which is a very different
conversation from one seller's word against one buyer's.

## Returns

If it comes back, the item moves to Returned with the reason.

From there it either goes back into the pipeline for relisting, in which case
regrade it if anything changed in transit, or it gets written off. Both are
normal. What the status is for is making sure a returned item does not silently
disappear from your inventory while still occupying a shelf.

## Message the buyer

Not required, and the cheapest thing you can do for a repeat sale.

A short note when you dispatch, naming what you sent and when it should arrive,
prevents most "where is my item" messages and a decent share of item-not-received
claims. It costs thirty seconds and it is the single highest-return unforced
action in resale.

It also gives the buyer somewhere to raise a problem that is not a case.
