---
slug: scan-mode
title: Scan mode
category: extension
visibility: public
audience: buyer
sort_order: 70
pillar_path: /where-to-sell-used-clothes
summary: Badges on a whole search page rather than one listing, why it can run automatically when nothing else does, and what it deliberately does not do.
faq:
  - q: Why does scan mode run automatically when the condition check does not?
    a: Because it grades nothing. It fetches no photo and makes no Vision call, so it spends nothing. The condition check does, which is why that one waits to be asked.
  - q: Does it tell me the real condition?
    a: No. It tells you what the seller claimed and whether the asking price is high or low for that claim. Establishing the real condition needs a proper read of the photos.
---

Scan mode works on search and category grids rather than on one listing. It
badges every result at once, so a page of forty jackets stops being forty
identical rectangles.

It is on by default, which no other mode is, and the reason is worth
understanding.

## What it puts on each result

**The claimed condition.** Whatever the seller selected, read off the grid.

**Whether the price fits the claim.** High or low compared with what items
claiming that condition typically go for.

That is all, and the second one is the useful half. A page where every listing
says "excellent" is uninformative until you can see that three of them are
priced like it and the rest are not.

<!-- SCREENSHOT: an eBay search page with scan badges on each result (as of 2026-08-15) -->

## Why it can run automatically

Because it spends nothing.

Scan mode **fetches no photo and makes no Vision call**. It reads what is
already on the page you loaded and compares it against pricing data. There is no
per-result cost, so running it on every grid costs you nothing and there is no
reason to make you ask.

The condition check is the opposite: it fetches photos and grades them, which
costs a Vision call, so it is click-to-run and its automatic setting defaults to
off. Flip mode costs a metered action, so it is click-to-run permanently.

The rule across all three is the same: a mode that spends something asks first,
and a mode that does not, does not bother you.

## What it deliberately does not do

**It does not grade.** No badge on a scan result is a condition assessment,
because nothing looked at the garment. It reports a claim and a price comparison.

Treating a scan badge as a condition read would be the one genuinely misleading
thing this feature could do, which is why the wording on the badge is about the
claim rather than about the garment.

To establish real condition, open the listing and run a condition check. Scan
mode's job is to tell you which three of the forty are worth opening.

## Turning it off

In the options page, globally or per site. It is a setting like any other, and
turning it off is remembered.

Per-site opt-out is reversible from the same page. That matters because the
easiest way to lose a feature permanently is to turn it off somewhere with no
obvious way back.

## Using it well

The workflow it is designed for is triage.

Load a search, let the badges land, and use them to pick the two or three
listings whose price does not match their claim. Open those, run a condition
check on each, and pin the ones worth comparing.

That is three tools doing three jobs: scan narrows forty to three, the condition
check reads those three properly, and the compare tray holds them side by side
while you decide.

## What the price comparison is based on

The comparison is against what items claiming that condition typically sell for,
not against a valuation of the specific garment.

That distinction matters. A listing badged as priced low might be a bargain, or
it might be priced correctly for a garment in worse shape than its claim. The
badge narrows where to look; it does not answer the question.

## Why it is the first of three tools

Used properly, the three modes form a funnel and each is cheap relative to the
one after it.

Scan costs nothing and narrows forty listings to three. The condition check costs
a Vision call and reads those three properly. The compare tray costs nothing
again and holds the survivors side by side while you decide.

Running the condition check on all forty would work and would be a waste. Running
scan on nothing and opening listings at random is the situation everybody was in
before.
