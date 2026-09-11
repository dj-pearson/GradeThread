---
title: What a sale ends, and how
aliases: [delist after sale, sibling delist, delist button]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/cross-listings.ts
  - services/edge-functions/src/lib/pending-delists.ts
  - services/edge-functions/src/routes/flipdesk-listings.ts
  - services/edge-functions/src/routes/flipdesk-extension-queue.ts
  - extension-unified/lister/lister-guard.js
  - extension-unified/lister/common.js
  - src/components/flipdesk/delist-panel.tsx
  - src/components/flipdesk/record-sale-dialog.tsx
  - src/lib/delist-links.ts
reviewed: 2026-09-11
tags: [flipdesk, delist, extension, cross-listing]
summary: A sale on any marketplace ends every other live listing of the same item; API channels end on the server, extension channels in the seller's browser from a link or by searching their active listings, and every listing keeps a link to that marketplace's own active-listings page as the fallback.
---

# What a sale ends, and how

US-3369. A seller sold on Poshmark and then ended every other listing by hand.
Four separate faults produced that, and each rule below closes one of them.

## 1. Siblings are the whole item

When a listing sells, every other `draft` or `active` listing of the same
`inventory_item_id` is ended. The `draft_id` cross-listing group is no longer
the key: extension-only items never get one (the writeback joins an eBay row's
group, and there is no eBay row), and an eBay base that was never cross-pushed
does not point at itself. Both made a sale end nothing.

A `sold` sibling still counts as a double sale only inside the `draft_id`
group. Item-wide, a sold row is as likely to be an old sale of a returned and
relisted garment, and a false oversell alarm on every return is how that
warning stops being read. `selectSiblingRows` in `cross-listings.ts` is the rule.

## 2. Every sale runs the same engine

`endOtherListings` is called by every order webhook, the sold-sync, and
Record sale (through `POST /api/flipdesk/listings/end-other-listings`). Record
sale asks where the item sold and marks that listing sold; before, it closed
the item's primary listing whatever the marketplace. The automatic callers
honour `flipdesk_settings.auto_end_cross_listings`. The Delist button sends
`mode: "explicit"` and does not, because pressing it is the seller saying yes.

## 3. A stamped row is reachable if the extension has a way in

`isAutoDelistable(platform, url)` answers whether the extension can reach the
listing: a saved link, or a platform in `LOCATE_DELIST_PLATFORMS` whose
active-listings page it can search. It does not look at `listing_status`.
Every stamped row has already been set to `ended` locally in the same write,
so the old rule (`active` and a URL) answered false for all of them and the
popup said "By hand" for every sale.

The background queue still only takes rows that were `active` before the
sale. A draft is searched only when the seller presses Delist.

## 4. Finding a listing with no link

The extension opens the page named in its own config
(`delist.locate.activeListingsUrl` in `lister/selectors.js`), never a URL from
a message. Poshmark's page is `/closet/{username}`; there is no handle-free
closet, so it needs `flipdesk_settings.marketplace_handles.poshmark`
(migration 00790), validated against `^[A-Za-z0-9._-]{1,40}$` everywhere it is
read.

On that page it picks ONE tile: a link matching `liveListingUrlPattern` whose
text covers at least 90% of a title's words, with no other tile at 75% or
more. Two look-alikes are reported, not guessed: ending the wrong garment is
worse than asking the seller to end the right one. The listing page it lands
on must also read like the title before anything is clicked. The first pass
of this was written without a live closet to test against, so a miss comes
back as "check it yourself", never as success.

## 5. A finished delist clears its stamp

A background delist that succeeds clears `delist_requested_at`
(`/extension-queue/:id/complete`). Nothing did before, so the robot ended the
listing and FlipDesk kept asking the seller to end it. A confirmed delist
drops any still-`queued` delist job for that listing.

## 6. The fallback link

Every live listing, and every row the Delist button could not finish, links
to that marketplace's own active-listings page (`activeListingsLink` in
`src/lib/delist-links.ts`). The web links and the extension's locate pages are
the same pages; `delist-links.test.ts` fails if they drift apart. Vinted has
no handle-free wardrobe page, so its link is the site's front door and says so.

## Related

- [[cross-listing]] — which marketplaces are reachable how
- [[closing-a-coverage-gap]] — what a new channel needs before it can delist
- [[sync-source-of-truth]] — field ownership once a listing exists on two channels
