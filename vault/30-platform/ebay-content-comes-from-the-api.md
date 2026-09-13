---
title: eBay content comes from the API, on every path
aliases: [no scraping ebay, API License Agreement, growth check]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ebay-item-read.ts
  - services/edge-functions/src/lib/extension-scan.ts
  - extension-unified/research/marketplace.js
  - extension-unified/test/ebay-no-scrape.test.cjs
reviewed: 2026-09-13
tags: [ebay, compliance, extension, contract]
summary: eBay listing content may only reach our servers or our surfaces through eBay's API - and the rule binds every path, not just the one a story happened to name.
---

# eBay content comes from the API, on every path

eBay's API License Agreement says eBay content is obtained through the API. A
shopper's browser is not the API. Reading a title, price, condition or photo out
of an eBay page and sending it to us is the single finding most likely to end an
Application Growth Check and put the production keyset at risk.

The rule is short. What it costs is remembering that it binds **paths**, not
features.

## The rule

On an eBay host the client sends an **identifier** and nothing else:

| Path | What leaves the browser | Who resolves it |
|---|---|---|
| Grade (detail page) | `ebayItemId` | `readEbayListingForGrading` |
| Ingest / alerts | the listing URL | `hydrateEbayListingBody` |
| Flip appraisal | the listing URL | `hydrateEbayListingBody` |
| Scan (search grid) | `key` + `ebayItemId` per card | `readEbayCardsByLegacyIds` → `hydrateEbayScanCards` |

The server **replaces** the caller's fields rather than merging them. A merge
leaves a caller able to steer the result with page text on the one marketplace
where we deliberately do not read the page, which makes the change cosmetic.

Every other marketplace passes through unchanged. Poshmark, Mercari, Grailed,
Depop and Vinted publish no API to read instead — that is a real difference, not
an inconsistency.

## The trap: a fence around one path is not a fence

US-3042 removed the detail-page scrape, shipped a source-level guard, and was
recorded as closed on that criterion. The guard covered `runGrade`,
`alertControls`, `runAppraise` and their three senders — the paths the story's
wording enumerated.

Scan mode was a fourth path. It read the title, price and condition off **24
eBay search tiles per page** and posted all of them, and it had been doing so
since US-2237. Nothing was red. The guard was green, the story read as done, and
the largest-volume instance of the exact finding was sitting one screen earlier
in the same content script.

So: when a compliance fence is written for a surface, enumerate that surface's
paths from the code, not from the story text. Ask what else on this host sends
a request, and check each one. The grep that would have found it is one line —
every call site of a DOM extractor in `research/marketplace.js`.

## The corollary: a required sentence is a factual claim

eBay also asks for attribution and a non-endorsement notice wherever its data is
shown. The compare tray stored a pinned row's title, price, seller and thumbnail
**read off the page**, and printed them under "Listing data from eBay, retrieved
through the eBay API".

Both halves of that were required and one half was false. A compliance notice
that misstates provenance is worse than a missing one, because it is a claim a
reviewer can check. The fix is two-sided: the pinned row's fields now come from
the endpoint's echo of eBay's own response, and each row **stores** where its
fields came from (`source: "ebay-api" | "page" | "unknown"`), so the compare view
picks wording that matches. An unstamped row defaults to `unknown` and gets the
sentence that claims nothing — never the flattering one.

## What guards this

- `extension-unified/test/ebay-no-scrape.test.cjs` — source-level, per path. It
  now covers the grid (`collectCards`, `runScan`, `scanCards`) and the pin path
  as well as the original three. Where a page was scraped is not a property any
  behavioural test can see: a scraped title and an API title are the same string.
- `extension-unified/test/ebay-attribution.test.cjs` — the two wordings, the
  row-source selection, and which surfaces mount a notice.
- `services/edge-functions/src/tests/extension-scan_test.ts` — that the route
  hydrates AND then uses the hydrated cards. Calling the hydrator and going on to
  score `parsed.cards` anyway is a one-word edit no behavioural test here sees.

Two mechanics worth knowing before editing those guards. A needle that slices a
function body (`indexOf("} : {")`) returns `-1` when it misses, and `slice(x, -1)`
then reads as "the rest of the file" — which contains no `title:` and passes
cleanly; use the `arm()` helper, which fails when either end is missing. And a
statement-level rule ("the extractor call must mention the id") is satisfied for
free when the surrounding object literal carries an `ebayItemId:` **field**, so
`collectCards` is guarded by counting guarded-vs-total reads instead.

## Related

- [[ebay-trading-api-watch]] — the other standing constraint on which eBay APIs we may call
- [[extension-adapter-verification]] — proving an adapter reads a real listing
- [[guards-that-cannot-fail]] — the general shape of a fence that passes against broken code
- [[INDEX]]
