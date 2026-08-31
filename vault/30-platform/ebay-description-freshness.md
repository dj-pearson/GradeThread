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
reviewed: 2026-08-31
tags: [ebay, publishing, listings, gotcha]
summary: An eBay description is frozen text — eBay bans active content and off-eBay links — so anything time-varying in it goes stale until a scheduled revise re-renders it.
---

# eBay descriptions cannot self-update — refresh by revise

> **Re-reviewed 2026-08-31.** Drift flagged `ai-listing.ts` for `1ec50c48c`
> (US-3031), which settles the generated eBay condition against the resolved
> category's allow-list, placed before the comp search so pricing reflects the
> condition that will actually publish. It writes `listing.ebay_condition` and
> nothing else; the description path is untouched. Re-verified while here: the
> description is still rendered from its own blocks by
> `lib/description-blocks.ts` (`ai-listing.ts:596`) into the `RenderContext` at
> `:2611`, and it is still frozen HTML once eBay has it.

> **Re-reviewed 2026-08-28 (US-2959, US-2963).** A description is assembled from
> `listings.description_blocks` now, so both refs moved for real. `ai-listing.ts`
> no longer concatenates strings: it builds a block array and calls
> `renderDescription` once, and the credential badge is the `credentials` block
> rather than an appended tail. The cron grew a second path to match — see
> [[#Two refresh paths]]. The freshness RULE is unchanged and is what this note
> is for.
>
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
behind the `<!--gradethread-seller-credentials-->` marker — by the `credentials`
block since US-2959, by string concatenation in `ai-listing.ts` before it)
carries the seller's **running** totals: "N items independently graded ·
X / 10 average condition grade". Two of one seller's live listings read
"13 items" and "19 items" at the same moment — both correct on their publish
date, both advertising the same seller.

## The only compliant refresh: revise

eBay permits revising a description **at any time, free, on an active listing —
even one with sales or bids.** So freshness is a cron, not a renderer feature:
`/api/jobs/credentials-refresh` (daily) re-renders the block and PUTs it onto
the live offer.

Four rules that path must keep, each of which is a way to break a seller's
listing rather than a nicety:

- **Replace the block, not the tail.** The grade/cert line
  (`applyGradeListingPromotion`) is appended AFTER the block, so
  "everything from the marker to the end" would swallow "Cert #GT-…".
- **Never inject.** No block in the description means the seller did not have
  one when they drafted it. Adding one is pushing marketing copy into someone
  else's writing. An unrecognised shape is treated the same way: leave it.
- **The LIVE description is the truth about what buyers see**, read back via
  `getOffer` — the stored copy can have drifted (an eBay-side edit, a failed
  earlier revise).
- **Compare before calling.** The seller's average moves with every new grade,
  which dirties every listing at once. Compare the stored copy first (a
  steady-state run makes zero eBay calls), cap writes per run, and rotate
  least-recently-updated first so a backlog larger than the cap still drains.

## Two refresh paths

US-2963 split the cron in two on `listings.description_blocks`, and the split is
the point rather than a migration detail.

**Block-backed (`description_blocks` non-null): re-render.** The description is
DERIVED, so the fresh bytes come from `renderListingDescription` and the whole
string is compared against the live offer and PUT. Two guards ride with it: a
render that would REMOVE the badge is refused and logged
(`credentials_refresh.render_would_drop_block`) rather than pushed, and
`renderAndPersistDescription` writes `description_blocks` and
`listing_description` in the same update so the columns cannot disagree.

**Legacy (`description_blocks` null): surgery.** `refreshSellerCredentialBlock`
walks `<div>` depth and replaces exactly one element inside the live string.
That walk gives up on an unclosed element or after `MAX_TAG_SCAN` tags, and its
only safe answer is `null` — which the loop counts as "no block" and skips. So a
malformed description defeated the refresh permanently and silently. It still
does on this path; the block-backed path is what removes that failure, one
listing at a time as they convert.

## What `no_block` was hiding

US-3028. The cron reported one counter, `no_block`, for every listing it left
alone, and its own doc comment read "No block in the description; left alone
(never injected)". That is true of exactly one of the four situations underneath
it. `findSellerCredentialBlock` answers `null` when the marker is absent AND
when the marker is there but the next element is not a `<div>`, AND when the
`<div>` never closes, AND after `MAX_TAG_SCAN` tags. The last three mean the
badge IS live and IS stale, on a listing the legacy path then skips every night.

A production run on 2026-08-30 read
`{revised: 0, up_to_date: 8, no_block: 13, errors: 0}` over 21 listings, and
nothing in it could distinguish "13 sellers who never opted in" from "13 stale
badges nobody can reach". That is the failure this note has warned about since
2026-08-28, arriving as a clean-looking success.

The verdict is now one call, `classifyRefreshSkip`, taken before either path
picks the listing up — so the never-inject rule has a single site rather than
one per path — and it splits into `no_marker` (benign), `unparseable` (a walk
failure, logged with the listing id and the reason) and `blocks_disagree`
(`description_blocks` carries a `credentials` block while the stored string has
no marker, so the two columns disagree about what was published). **A healthy
run has `unparseable` and `blocks_disagree` both at zero**; anything above that
is a bug report, and `credentials_refresh.stale_blocks_unreachable` says so in
the log rather than leaving it to be read out of a counter.

## The freshness check never asks eBay

Still open, and worth knowing before trusting a `revised: 0`. Both paths decide
freshness from the DB copy of `listing_description` and only call `getOffer`
once they already believe the listing is dirty. That is the deliberate
cost-control choice (a steady-state run makes zero eBay calls), and its price is
that DB/live divergence is permanent: the eBay pull does not correct it either,
because `listing_description` is locked on GradeThread-origin listings
(`LISTING_PULL_ALLOWED_ON_GT_ORIGIN` in `sync-precedence.ts`) and drift is only
recorded, in `platform_fields.sync_drift`. So a revise that failed once leaves
eBay stale and the row fresh, and every later run reports `up_to_date`. The
cheap fix, if this turns out to bite, is to treat a `sync_drift` marker naming
`description` as dirty — the sync already writes it, so it costs no eBay call.

`inventory_items.description` keeps the surgery either way: it is a plain string
with no blocks behind it, and it is the fallback `resyncGradeToLiveListing`
reads, so a stale badge there resurfaces through that path however carefully the
listing was re-rendered.

## The alternative we rejected

Coarse wording — "15+ items graded" instead of an exact count — would age
slowly enough to need no cron at all, and costs nothing. It was offered and not
taken: exact numbers are the trust signal. Worth revisiting if the revise volume
ever becomes the constraint, since the two combine well (bands cut how often the
block changes; the sweep catches it when it does).

Related: [[ebay-aspect-value-limit]] (the other publish-time constraint that
surfaces late), [[cross-listing]] (the other marketplaces the same block reaches
as plain text).
