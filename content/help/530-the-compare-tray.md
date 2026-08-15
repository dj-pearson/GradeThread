---
slug: the-compare-tray
title: The compare tray
category: extension
visibility: public
audience: buyer
sort_order: 40
pillar_path: /compare
summary: Pinning up to six reads so you can compare them side by side, why the tray never re-queries, and where the pinned data actually lives.
faq:
  - q: Does opening the tray re-grade anything?
    a: No. It makes no network call at all. Every figure was returned when you pinned it, and a row that quietly refreshed itself would no longer be the thing you were comparing.
  - q: Where are the pins stored?
    a: In your browser's own storage, capped at six, oldest out. Nothing is sent anywhere and nothing is stored on our servers.
---

Nobody buys one listing. They choose between six of the same jacket at six
prices, and until the tray existed every read was discarded on the way to the
next candidate.

## Pinning

Run a condition check, then pin it. The read goes into the tray with everything
the check returned: score, tier, factors, confidence, price, seller, and the
listing URL.

The tray holds **six**. Pin a seventh and the oldest drops out. Six is roughly
the number of candidates a person actually holds in their head, and a tray of
twenty is a spreadsheet nobody opens.

<!-- SCREENSHOT: the compare tray with four pinned listings side by side (as of 2026-08-15) -->

## Opening it

From the extension popup. It opens in its own tab.

It opens that way rather than as a link on the marketplace page for a specific
technical reason: linking to it from inside the page would require the extension
to expose its own resources to every marketplace site it runs on, which is a
wider permission than it needs.

## It never re-queries

Opening the tray makes **no network call at all**. Not a re-grade, not a price
refresh, not a check that the listing still exists.

Every figure was returned by the endpoint at the moment you pinned it. That is
deliberate and it is the whole point of the feature: a row that quietly
refreshed itself would no longer be the thing you were comparing, and you would
be making a decision against numbers that changed while you were looking away.

It is also why pinning costs nothing. The read was already paid for; pinning
stores what came back rather than asking again.

## What you can see side by side

Score and tier, which is the comparison that matters most and the one no
marketplace offers.

The factor breakdown, so a 7.2 that lost its points on fabric can be told from a
7.2 that lost them on a broken zip. Those are different purchases.

Price and confidence together, which is the pair that usually decides it: a
higher score at lower confidence is a weaker case than a slightly lower score
the read was sure about.

## Where the pins live

In your browser's own storage. Not on our servers, not attached to your account,
not synced between browsers.

That means a tray built on your laptop is not on your phone, which is a real
limitation and the honest consequence of not uploading your shopping. Clearing
your browser data clears it.

## Clearing it

Unpin individually, or clear the tray. Both are in the tray itself.

Pins do not expire on their own. A listing you pinned three weeks ago is still
there, showing what it showed three weeks ago, and it may well have sold since.
The URL is on the row, so checking is one click, and that is a better default
than the tray silently dropping things it thinks are stale.

## Using it while sourcing

The tray is as useful to a reseller as to a shopper, and for a different reason.

Six candidates for the same garment at six prices is the ordinary situation when
sourcing, and the decision is not simply the cheapest. A 6.4 at half the price of
an 8.1 is often the worse buy once you count what each will list for.

Pinning both and reading the factor rows side by side answers that in a way no
marketplace's own comparison does, because no marketplace has a condition number
to compare with.

## Two habits worth having

**Pin before you decide, not after.** The tray is a decision aid, and pinning the
one you already chose tells you nothing.

**Clear it between hunts.** Six pins from last week's search sitting alongside
this week's three is confusing rather than helpful, and clearing takes one click.

The pins do not expire on their own, deliberately. An automatic clean-up that
removed something you were still thinking about would be worse than a tray you
occasionally tidy.
