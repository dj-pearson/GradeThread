---
slug: publishing-a-listing
title: Publishing a listing
category: flipdesk
visibility: public
audience: seller
sort_order: 90
pillar_path: /flipdesk
summary: What happens when you publish, why eBay works differently from every other channel, and what to do when a publish gets stuck.
faq:
  - q: Why does eBay publish instantly and Poshmark open a browser tab?
    a: eBay has an official listing API, so FlipDesk talks to it directly. The others have no such API for sellers, so the browser extension fills their own form in your logged-in tab.
  - q: My listing is stuck. What now?
    a: Almost always a required item specific that is missing or too long. The status shows the channel's own error rather than a generic failure, and the fix is usually in the composer.
---

Publishing takes a draft and makes it live. How that happens depends on the
channel, and the difference is worth understanding because it explains most of
what can go wrong.

## Two mechanisms

**eBay uses an official API.** FlipDesk creates the inventory item, the offer
and the publish directly against eBay's own endpoints. No browser involved, no
tab open, and it works while you are asleep. This is why eBay is the channel
everything else is built around.

**Everything else uses the browser extension.** Poshmark, Mercari, Grailed and
Vinted have no seller listing API, so the extension fills their own sell form in
a tab you are logged into. It needs the browser open and the extension installed,
and it needs a paid FlipDesk plan.

That distinction explains the rest of this article.

## Publishing to eBay

Press publish. The offer is created and published, and the item moves to Listed
with its eBay URL attached.

When it fails, the reason comes back from eBay and is shown as eBay wrote it.
The two commonest are a missing required item specific for the category, and a
value longer than the 65 characters eBay allows. Both are fixable in the
composer and both are checked before send now, which catches most of them at
your keyboard instead of after.

If the offer is created but not published, the item shows as stuck rather than
listed. That state is recoverable: fix the field, publish again, and the same
offer is reused rather than a duplicate created.

## Publishing everywhere else

Pick the channels and start the run. The extension opens each sell form in turn
and fills what it can.

**What actually works today**, verified against the extension's own adapters
rather than assumed:

| Channel | List | Delist |
|---|---|---|
| Poshmark | yes | yes |
| Mercari | yes | yes |
| Grailed | yes | no, permanently |
| Vinted | yes, vinted.com | not yet |
| Facebook Marketplace | no | no |

A channel that is not enabled says "list manually for now" rather than guessing
at the form. That is the correct behaviour and not a bug: a wrong guess at a
sell form types a price into whatever moved into that position.

Grailed's delist is permanent rather than pending. Deleting a Grailed listing is
confirmed by a native browser dialog that nothing inside a page can answer, so
it cannot be automated at all. Grailed and Vinted therefore get a pending-delist
marker and a reminder when an item sells elsewhere, so the copy you have to end
by hand is not the one you forget.

Some fields are left for you on purpose. Poshmark's price and photos live on a
later wizard step, and the flow reports that it attached zero photos rather than
claiming otherwise, so you finish in the tab you were going to be in anyway.

## After publishing

The item moves to Listed. A listings row is written per channel with its URL, so
the item shows as cross-listed and the reconciliation later has something to
match a sale against.

The certificate link goes in the description, not as a badge on the photo.
Several marketplaces treat overlaid graphics on listing images as a policy
problem, and a removed listing helps nobody.

## When it sells somewhere

The other copies need to come down, and that is the single most important thing
cross-posting has to get right. Selling the same garment twice is worse than not
cross-posting at all.

Where delist is supported it happens automatically. Where it is not, you get a
pending-delist reminder naming the channel and the listing, every time, rather
than being quietly left with a live listing for something you no longer own.

## Publish when people are looking

Timing matters more on some channels than others, and it costs nothing to use.

Scheduled drops let you queue a batch to publish at a chosen time rather than at
two in the morning when you happened to finish drafting. On channels that weight
recency in search, landing during a browsing peak is worth real money.

It is also the difference between forty listings all going live at once and
competing with each other, and forty spread across a week.
