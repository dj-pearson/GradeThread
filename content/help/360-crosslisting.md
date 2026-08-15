---
slug: crosslisting
title: Crosslisting
category: marketplaces
visibility: public
audience: seller
sort_order: 50
pillar_path: /reselling/best-crosslisting-apps
summary: Which channels FlipDesk can actually post to today, what happens on each, and why the delist half matters more than the list half.
faq:
  - q: Which marketplaces can FlipDesk list to?
    a: eBay through the official API, and Poshmark, Mercari, Grailed and Vinted through the browser extension. Facebook Marketplace is not enabled and says so rather than guessing.
  - q: Why does Grailed never delist automatically?
    a: Its delete is confirmed by a native browser dialog, which nothing running inside a page can answer. It is a permanent wall, not a missing feature, so you get a reminder instead.
---

Crosslisting puts the same item on several channels. It roughly multiplies your
audience, and it introduces exactly one serious risk, which is selling the same
garment twice.

## What works today

Verified against the extension's own adapters rather than assumed:

| Channel | Mechanism | List | Delist |
|---|---|---|---|
| eBay | official API | yes | yes |
| Poshmark | extension | yes | yes |
| Mercari | extension | yes | yes |
| Grailed | extension | yes | never |
| Vinted | extension, vinted.com | yes | not yet |
| Facebook Marketplace | extension | no | no |

A channel that is not enabled reports "list manually for now" rather than
attempting the form. That is correct behaviour: a wrong guess at a sell form
types a price into whatever field has moved into that position, and the result
is a live listing at the wrong price.

Vinted has twenty-two country domains. Listing is verified on vinted.com; an
uncovered locale reports back rather than guessing, for the same reason.

## The two mechanisms

**eBay** has an official seller API, so FlipDesk acts server-side. No browser,
no tab, works overnight.

**Everything else** has no seller listing API, so the browser extension fills
each site's own form in a tab you are logged into. That needs the browser open,
the extension installed, and an active paid FlipDesk plan.

The extension leaves some fields for you on purpose. Poshmark's price and photos
sit on a later wizard step, and the flow tells you it attached zero photos rather
than claiming otherwise, so you finish in a tab you were going to be in anyway.

## Why delist matters more than list

Listing in five places is a convenience. Failing to remove four of them when one
sells is a real problem: you owe somebody a refund, you take a metric hit, and
you have spent a garment you no longer have.

Where the channel supports it, delisting is automatic when a sale is recorded.

Where it does not, you get a **pending delist**: a marker on the item and a
reminder naming the channel and the listing, every time, until you end it.

Grailed is permanent. Its delete is confirmed by a native browser dialog that
nothing inside a page can answer, so no automation of any kind can do it. Vinted
is unverified, which is a gap rather than a wall.

Both remain in the reminder set precisely so the copies you must end by hand are
the ones you are told about, rather than the ones you forget. Being told every
time is a worse experience than automation and a much better one than a double
sale.

<!-- SCREENSHOT: an item showing a pending delist reminder -->

## Practical advice

**Start with two channels.** eBay plus whichever one suits what you sell.
Managing five is a different job and the returns diminish quickly.

**Match the channel to the goods.** Grailed for menswear and streetwear.
Poshmark for women's contemporary. Vinted for volume at lower prices. Listing
everything everywhere mostly produces noise.

**Keep the browser channels in one session.** Since the extension needs you
logged in, do a crosslisting run as a batch rather than one item at a time.

**Check the pending delists weekly.** They are the one thing in this workflow
that genuinely needs a human, and a weekly sweep is enough.

## The cost nobody counts

Crosslisting is not free even when it is automated. Every extra channel is
another set of messages, another metric to keep, another set of rules to breach
accidentally, and another copy to remember to end.

Two channels done well beats five done carelessly, and the second one should
earn its place before the third is added. The test is simple: is the second
channel producing sales you would not otherwise have had, or the same sales
later.
