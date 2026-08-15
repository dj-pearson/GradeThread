---
slug: the-lister
title: The Lister
category: extension
visibility: members
audience: seller
sort_order: 80
pillar_path: /reselling/best-crosslisting-apps
summary: Cross-posting your FlipDesk drafts from your own logged-in tabs, exactly which channels work today, and why one of them can never delist.
faq:
  - q: Which channels can it post to?
    a: Poshmark, Mercari, Grailed and Vinted. Facebook Marketplace is not enabled and says "list manually" rather than guessing at the form.
  - q: Why does it need my browser open?
    a: Because these marketplaces have no seller listing API. The only way to create a listing is to fill their own form, in a session already logged in as you.
---

The Lister cross-posts your FlipDesk drafts to marketplaces that have no seller
API, by filling their own sell forms in tabs you are already logged into.

It needs an active paid FlipDesk plan.

## Why it works this way

eBay has an official seller API, so FlipDesk lists there server-side with no
browser involved.

Poshmark, Mercari, Grailed and Vinted do not. There is no endpoint to call, so
the only way to create a listing is to fill the form a human would fill, in a
session that is already authenticated as you. That is what the extension does.

The consequences follow from that: your browser has to be open, you have to be
logged into the channel, and the run is visible in tabs rather than happening
quietly on a server.

## What actually works today

| Channel | List | Delist |
|---|---|---|
| Poshmark | yes | yes |
| Mercari | yes | yes |
| Grailed | yes | never |
| Vinted | yes, vinted.com | not yet |
| Facebook Marketplace | no | no |

A channel that is not enabled reports **"list manually for now"** rather than
attempting the form. That is the correct behaviour: a wrong guess at a sell form
types a price into whatever field has moved into that position, and the result is
a live listing at the wrong price.

Vinted has twenty-two country domains. Listing is verified on vinted.com, and an
uncovered locale says so rather than guessing.

<!-- SCREENSHOT: a lister run showing per-channel progress -->

## Grailed can never delist

Not "not yet". Never, in this design.

Deleting a Grailed listing is confirmed by a **native browser dialog**, and
nothing running inside a page can answer one. No extension, no script, no
automation of any kind can click it.

So Grailed listings get a **pending delist**: when the item sells elsewhere, you
are told, every time, naming the channel and the listing, and you end it by hand.

That is a deliberate trade rather than a hidden gap. The failure it avoids is the
one that actually hurts: a channel where the seller is never told, the sibling
listing stays live and purchasable, and they owe two people one garment.

Vinted is in the same reminder set for a different reason: its delist is
unverified rather than impossible.

## What it leaves you

Some fields on purpose. Poshmark's price and photos live on a later wizard step,
and the flow reports that it attached zero photos rather than claiming otherwise.
You finish in the tab you were going to be in anyway.

That honesty is the point. A tool that said "listed" when it had filled half a
form would cost you more than one that says what it did, and the alternative --
guessing at the later step -- is exactly how a listing goes live at the wrong
price.

## Running one

Pick the drafts, pick the channels, start. Each form opens in turn.

Do it as a batch. Since the browser has to be open and you have to be logged in,
a crosslisting session is a different shape from listing one item, and doing
twenty in one sitting is far less interruption than twenty separate ones.

## If a channel stops working

Marketplaces redesign their forms, and a redesign moves the fields the extension
looks for.

The popup has a **Check selectors** action that runs every selector for that
platform against the live page and reports which miss. The report names the host,
the version and the per-selector verdicts, and deliberately carries no page
content and no full URL, because it is written to be pasted somewhere.

That report is the useful thing to include in a ticket. See
[When a site stops working](/help/extension/when-a-site-stops-working).

## Pacing and caps

Engagement actions such as sharing are paced and capped rather than run flat out,
with randomised timing and a floor on the interval.

The caps are conservative on purpose: they sit well below the level at which
sellers report a marketplace intervening. A limit you can raise is offered; a
limit you can lower is not, because the only reason to go faster is to go faster
than the channel is comfortable with.

If a run meets a human verification challenge, it stops and hands the tab back to
you. It is never solved, never outsourced and never retried around.
