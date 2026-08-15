---
slug: delisting-and-lifecycle
title: Delisting and listing lifecycle
category: marketplaces
visibility: public
audience: seller
sort_order: 55
pillar_path: /flipdesk
summary: The states a listing moves through, what happens when eBay ends one without asking you, and how FlipDesk notices a listing that has quietly gone.
faq:
  - q: eBay ended my listing. Why?
    a: Usually a policy issue, an out-of-stock condition, or the listing simply expiring. The reason is recorded against the listing rather than the item vanishing from your inventory.
  - q: What is a pending delist?
    a: A reminder that a copy of a sold item is still live somewhere FlipDesk cannot end automatically. It stays until you end it by hand.
---

A listing is not a permanent object. It gets created, revised, sometimes ended
by somebody other than you, and eventually closed. Knowing the states saves a
lot of confusion.

## The states

**Draft.** Exists in FlipDesk only.

**Active.** Live on a channel, with a URL.

**Ended by you.** You took it down deliberately.

**Ended by the channel.** The marketplace removed or expired it.

**Sold.** It transacted.

The item and the listing are separate things. An item can have several listings,
one per channel, and each has its own state. Ending one does not touch the
others or the item.

## When the channel ends it

This is the case that surprises people, because nothing on your side did
anything.

**Expiry.** Some listing formats end after a fixed period unless renewed.

**Out of stock.** eBay ends a listing whose quantity reaches zero.

**Policy.** The listing was removed for a rule violation, which for clothing is
most often a prohibited material, a brand restriction, or an image issue.

**A policy you removed.** If a business policy a listing references is deleted
on eBay, listings depending on it can be ended.

FlipDesk records the reason against the listing rather than letting the item
quietly disappear from your inventory. An item whose listing was ended by the
channel is still yours, still on your shelf, and still needs a decision.

<!-- SCREENSHOT: a listing showing an ended-by-channel state with the reason (as of 2026-08-15) -->

## Noticing a listing that went

Reconciliation between what FlipDesk believes is live and what the channel
reports runs periodically for eBay, which has an API to ask.

That is how an ended listing gets noticed without you checking manually. Without
it, an item shows as Listed indefinitely while nothing is actually for sale,
which is the worst kind of wrong: it looks fine.

Extension channels cannot be polled, because there is no API to poll. Their
state changes when you tell FlipDesk, which is a real limitation and is worth
knowing rather than assuming otherwise.

## Delisting on purpose

Ending a listing is supported everywhere the channel allows it: eBay through the
API, Poshmark and Mercari through the extension.

**Grailed cannot be automated at all.** Its delete is confirmed by a native
browser dialog that nothing running inside a page can answer. That is permanent
in this design rather than a missing feature.

**Vinted is not yet verified.** The delist probe has only ever run on a page that
was not one of the seller's own live listings, where the menu cannot exist, so
the miss proves nothing either way.

Both stay in the reminder set, which is the point: a channel that cannot be
automated is a channel you must be told about, every time.

## Relisting

An item whose listing ended without selling goes back into the pipeline. Change
what you learned, usually the price or the photos, and publish again.

Relisting is not free on every channel. Some treat a fresh listing better in
search than a revised old one, and some do the opposite. If an item has sat
unsold for a long time, a genuinely new listing with new photos and a lower
price outperforms a price edit on the old one more often than not.

## Returns are a different state

A returned item is not an ended listing. It is a completed sale that reversed,
and it moves to Returned so the garment does not silently vanish from your
inventory while still sitting on a shelf. Relist it or write it off; both are
normal.

## Check the live set periodically

Once a month, compare what FlipDesk shows as Listed against what is actually
live on each channel.

For eBay this happens automatically. For the extension channels it does not,
because there is no API to ask, and drift accumulates: a listing you ended in
the app, a listing the channel removed, a listing you forgot.

Ten minutes a month keeps the inventory honest, and an inventory you trust is
the thing every other number depends on.
