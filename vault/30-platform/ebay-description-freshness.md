---
title: eBay descriptions cannot self-update — refresh by revise
aliases: [active content, stale credential block, description refresh]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/seller-credentials.ts
  - services/edge-functions/src/routes/jobs-credentials-refresh.ts
  - services/edge-functions/src/lib/ai-listing.ts
reviewed: 2026-08-28
tags: [ebay, publishing, listings, gotcha]
summary: An eBay description is frozen text — eBay bans active content and off-eBay links — so anything time-varying in it goes stale until a scheduled revise re-renders it.
---

# eBay descriptions cannot self-update — refresh by revise

> **Re-reviewed 2026-08-28 (US-2959, US-2963).** The freshness RULE is
> unchanged and always will be — it is eBay policy, not our code. What changed
> is the mechanism underneath it, twice, and both changes rewrite the four rules
> below. A description is now RENDERED from `listings.description_blocks`
> (US-2956..US-2960), generation builds those blocks rather than concatenating a
> string (US-2959, `ai-listing.ts`), and the refresh cron re-renders a
> block-backed listing instead of operating on its markup (US-2963). The section
> "Two mechanisms, one rule" below is the current state; the four rules that
> follow it now describe the LEGACY path only.

> **Re-reviewed 2026-08-17.** Drift flagged `seller-credentials.ts` for
> `b324cb03`, a certificate rendering fix that happened to touch the same
> commit. The freshness rule — an eBay description is frozen text, so anything
> time-varying belongs outside it — is unaffected, and nothing there changes
> what goes into a description.

Two eBay policies, together, mean **a published description is a snapshot**:

1. **No active content.** Script, iframe, form, applet, remote include — all
   banned in the description since 2017. There is no way to fetch a current
   value at view time.
2. **No off-eBay links.** A URL pointing at gradethread.com in the description
   gets the listing HIDDEN (observed hit, ref `2-106523659851`). So "see the
   live number on our site" is not a fallback either.

Anything time-varying we put in a description is therefore **frozen at draft
time and wrong from then on**. This is a design constraint, not a bug to fix in
the renderer.

## What this already bit

The verified-seller credential block (`buildSellerCredentialBlock`, emitted
behind the `<!--gradethread-seller-credentials-->` marker — by the block
renderer since US-2959, by string concatenation in `ai-listing.ts` before it)
carries the seller's **running** totals: "N items independently graded ·
X / 10 average condition grade". Two of one seller's live listings read
"13 items" and "19 items" at the same moment — both correct on their publish
date, both advertising the same seller.

## The only compliant refresh: revise

eBay permits revising a description **at any time, free, on an active listing —
even one with sales or bids.** So freshness is a cron, not a renderer feature:
`/api/jobs/credentials-refresh` (daily) refreshes the block and PUTs the result
onto the live offer.

## Two mechanisms, one rule (US-2963, 2026-08-28)

The cron branches on whether the listing carries `description_blocks`.

**Block-backed listings re-render.** The description is derived state, so the
refresh is `renderListingDescription` followed by `renderAndPersistDescription`
— both columns in one update — and the freshly rendered string is what gets
PUT. No markup is read, which is the whole point: `findSellerCredentialBlock`
walks `<div>` depth and gives up on an unclosed element or after `MAX_TAG_SCAN`
tags, returning null. The loop reads null as "this listing has no block" and
skips it, every run, with no error and no log line. **One malformed description
defeated the refresh permanently and silently.** A render cannot be defeated
that way.

Three things the block path keeps, and they are the interesting part:

- **Never inject, still.** A stored description with no
  `<!--gradethread-seller-credentials-->` marker is skipped, exactly as before.
  The presence test is a plain `includes`, not the div walk.
- **Freshness is a substring, not a render.** The renderer emits the credential
  html verbatim after its marker, so `dbDesc.includes(html)` decides the
  question before any query. That is what keeps a steady-state run at zero extra
  cost across 200 sellers and 500 listings each — the same budget the compare
  rule below buys for the legacy path.
- **A render that would REMOVE the block is refused** and logged as
  `credentials_refresh.render_would_drop_block`. It means the two credential
  loaders disagree about a seller, or the block was switched off while the
  stored string still shows one. Silently stripping a buyer-facing trust badge
  is not a refresh.

One consequence worth knowing before it surprises someone: a block-backed
revise pushes the **whole** re-render, not a surgical swap, so a section whose
underlying field changed since publish updates too. That is the design's
accepted exception (see the epic's Risks section) — the description is derived
state, and the cron is the one background job allowed to re-derive a live one.

**Listings with `description_blocks` null take the legacy path below**,
unchanged, until a save converts them.

## The legacy path: four rules

These describe the pre-block mechanism, which still runs on every unconverted
listing. Each is a way to break a seller's listing rather than a nicety:

- **Replace the block, not the tail.** The grade/cert line
  (`applyGradeListingPromotion`) is appended AFTER the block, so
  "everything from the marker to the end" would swallow "Cert #GT-…".
  `refreshSellerCredentialBlock` walks `<div>` depth and replaces exactly one
  element.
- **Never inject.** No block in the description means the seller did not have
  one when they drafted it. Adding one is pushing marketing copy into someone
  else's writing. An unrecognised shape is treated the same way: leave it.
- **Swap inside the LIVE description**, read back via `getOffer` — not inside
  the stored copy. Otherwise a revise silently reverts eBay-side drift.
- **Compare before calling.** The seller's average moves with every new grade,
  which dirties every listing at once. Compare the stored copy first (a
  steady-state run makes zero eBay calls), cap writes per run, and rotate
  least-recently-updated first so a backlog larger than the cap still drains.

## The alternative we rejected

Coarse wording — "15+ items graded" instead of an exact count — would age
slowly enough to need no cron at all, and costs nothing. It was offered and not
taken: exact numbers are the trust signal. Worth revisiting if the revise volume
ever becomes the constraint, since the two combine well (bands cut how often the
block changes; the sweep catches it when it does).

Related: [[ebay-aspect-value-limit]] (the other publish-time constraint that
surfaces late), [[cross-listing]] (the other marketplaces the same block reaches
as plain text).
