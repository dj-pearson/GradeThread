---
slug: an-ebay-listing-is-stuck
title: An eBay listing is stuck
category: troubleshooting
visibility: public
audience: seller
sort_order: 50
pillar_path: /reselling/ebay-item-specifics
summary: What a stuck listing actually is, the two causes behind nearly all of them, and why fixing it does not create a duplicate.
faq:
  - q: What does stuck mean?
    a: eBay created the offer and then refused to publish it. The listing exists on their side and is not live, which is why it is neither a draft nor a listing.
  - q: Will fixing it create a second listing?
    a: No. Publishing again reuses the same offer rather than creating a new one, so there is no duplicate to clean up afterwards.
---

A stuck listing is a specific state: eBay accepted the offer and then refused to
publish it. It is not a draft and it is not live, which is why it looks like
nothing is happening.

## The two usual causes

**A required item specific is missing.** eBay requires different fields per
category and revises the list without much notice, so a listing shape that worked
last month can be rejected now.

**A value is longer than 65 characters.** Every item specific value has that
limit, enforced at publish. It is the cause people spend longest not finding,
because nothing about the message points at length.

Between them these account for nearly every stuck listing. Check the second one
first; it is faster to rule out.

## Fixing it

Open the composer. Both problems are visible there: missing required fields are
flagged, and anything over 65 characters is marked as you type.

Shorten or fill, then publish again. The same offer is reused rather than a new
one created, so there is no duplicate and nothing to tidy up.

The values that most often run long are Material on something with a complex
composition, and Style on a garment somebody described lovingly. The full text
belongs in the description, which has no such limit.

<!-- SCREENSHOT: the composer flagging a missing required specific (as of 2026-08-15) -->

## Read the error as eBay wrote it

The failure message is passed through unchanged rather than replaced with
something friendlier.

That is deliberate. eBay's errors name the exact field, and a generic "publish
failed" would throw away the one piece of information that fixes it. The wording
is theirs, and it is worth reading rather than skimming.

## The other causes

**Business policies.** A listing needs postage, returns and payment policies. If
one is missing, or does not cover the category or destination, eBay refuses. See
[eBay business policies](/help/marketplaces/ebay-business-policies).

**The connection needs refreshing.** If the item shows "reconnect required"
rather than a field error, the authorisation lapsed. Reconnect from Marketplaces;
it takes seconds and nothing is lost.

**A restricted item.** Some categories and materials are restricted on eBay.
That one is not fixable by editing a field, and the error says so.

## After a revision fails

Revising a live listing runs the same completeness check as publishing a new one,
so a requirement that appeared since the listing went up is caught and filled
rather than causing a silent failure.

That check exists because it was once missing, and revisions were failing for a
reason nobody could see from the outside.

## If it stays stuck

Open a ticket with the item and the exact message from eBay.

That message is what makes it answerable quickly, because it names the field. A
screenshot of the item sitting in a stuck state does not, since every cause looks
identical from there.

## Preventing it

Most stuck listings are preventable at the composer rather than at publish.

**Fill every required specific before publishing.** They are flagged, and a
flagged field left empty is a publish that will fail.

**Watch the length warning.** Anything over 65 characters is marked as you type,
and shortening it there costs seconds.

**Catalogue the category correctly first.** Required specifics vary by category,
so a late category change is a late change to what must be filled.

## What stuck does not mean

It does not mean the item is lost, the draft is gone, or anything has to be
recreated. The item, its photos, its measurements, its grade and its draft text
are all exactly where they were.

Stuck describes one listing attempt on one channel. Everything upstream of it is
untouched.
