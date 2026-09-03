---
title: eBay Partner Network attribution
type: reference
status: current
source_of_truth: vault
code_refs:
  - ios/GradeThread/Marketplaces/EbayOutboundLink.swift
  - services/edge-functions/src/lib/ebay-client.ts
reviewed: 2026-09-03
tags: [ebay, affiliate, epn, revenue, ios]
summary: What is and is not in place for eBay Partner Network commission, and the open question about whether an in-app purchase reached through a universal link is credited.
---
# eBay Partner Network attribution

GradeThread hands sellers to eBay constantly: Scout results, Prospect comps, and
(once US-3081 ships) Standing Scout alerts. eBay Partner Network pays a
commission when a purchase follows one of those links. This note records what is
wired, what is not, and the one question nobody has answered yet.

## State on 2026-09-03

| Piece | State |
|---|---|
| EPN publisher account | Created. Campaign id **5339154788** (not a secret — it appears in every public link) |
| `EBAY_PARTNER_ACCOUNT_SID` / `EBAY_PARTNER_AUTH_TOKEN` | Already set on the Coolify edge. These are the **Reporting API** credentials, not the link-attribution ones |
| `EBAY_EPN_CAMPAIGN_ID` | **Not set.** Until it is, no link carries attribution |
| `X-EBAY-C-ENDUSERCTX` header on Browse calls | Not sent. US-3082 AC3 |
| `itemAffiliateWebUrl` mapped into the result `url` field | Not done. US-3082 AC3 |
| iOS reads the `url` field | **Done (US-3097).** `ScoutCandidate.url` decodes today and `EbayOutboundURL.resolve` prefers it over `itemWebUrl`, so the affiliate link starts flowing the day the server sends it, with no App Store release |
| Browser extension | **Deliberately excluded.** EPN treats extensions and toolbars as software applications needing separate pre-approval; `extension-unified/test/attribution.test.cjs` fails the build if `campid`, `mkcid` or `affiliateCampaignId` appears in the bundle |

Link anatomy, for reference: `campid=` is the campaign, `mkcid=1` marks the EPN
channel, `mkrid=711-53200-19255-0` is the eBay US rotation id, `toolid=10001` is
the link generator, and `customid=` is the slot for a per-user reference.

## The open question: does an in-app purchase get credited?

**Unanswered as of 2026-09-03.** iOS opens eBay listings with
`UIApplication.open` on an `https://www.ebay.com/...` URL. When the eBay app is
installed, iOS hands that universal link to the app rather than to Safari — which
is the behaviour the seller wants, because they are already signed in there and
can buy the item they are standing in front of.

What is not established is whether eBay carries the `campid` through that
hand-off and credits the resulting purchase. Universal links pass the full URL,
query string included, into the app; whether eBay's app reads the EPN parameters
out of it and attributes the session is a question about eBay's implementation
and the EPN terms, not about ours. **Nobody has read the terms on this point and
nobody has run a test purchase.**

### Which branch shipped

US-3097 shipped the **universal-link branch**: `EbayOutboundLink` opens the
affiliate URL with `UIApplication.open` and takes the app hand-off. That is the
better seller experience, and it is the branch to keep if attribution survives.

**If it turns out an in-app purchase is NOT credited**, the fallback is already
specified in US-3097 AC7 and is a small change to one file: open the affiliate
URL in Safari (`SFSafariViewController`) so the click lands on the web where the
attribution is known to work, and offer "Open in eBay app" as a secondary action
for the seller who would rather have the app. One helper, one call site.

### How to settle it

1. Set `EBAY_EPN_CAMPAIGN_ID` and ship US-3082 so links actually carry `campid`.
2. Read the EPN program terms on mobile app traffic and record the date and the
   clause here.
3. Make one test purchase from the iOS app through a Scout link, with the eBay
   app installed, and check whether the click and the transaction appear in the
   EPN Reporting API (the credentials for which are already on the edge).
4. Record the rate card at the same time: the apparel commission rate, the
   per-item cap, and the click-to-purchase attribution window, dated, so the
   margin math is checkable and re-checkable.

Until step 3 is done, treat mobile commission as **unproven, not zero**.

## Telemetry that makes the answer checkable

`scout.outbound_open` (`TelemetryEvent.scoutOutboundOpen`) fires on every
hand-off with `platform`, the `surface` it came from, and an `affiliate` boolean
read off the URL's own query rather than off which field it arrived in. Without
that flag, a missing commission and a broken link look identical from our side.
It carries no user identifier beyond the session key Telemetry already attaches.

## Disclosure

US-3082 AC6 owns the seller-facing disclosure ("GradeThread may earn a commission
when you buy through these eBay links; it never changes the price you pay") on
the sourcing page, the alerts tab, and the privacy and terms pages. Per FTC
endorsement guidance that has to be visible where the links are, so the iOS Scout
and Prospect surfaces need the same line when attribution goes live — not before,
since a disclosure about a commission we do not yet earn is its own inaccuracy.
