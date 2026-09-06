---
title: Market condition index — what may be aggregated, and under what contract
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/listing-ingest.ts
  - services/edge-functions/src/lib/data-retention.ts
  - services/edge-functions/src/lib/resale-condition.ts
reviewed: 2026-09-05
tags: [privacy, buyer, extension, aggregation, contract]
summary: The fields the market condition index may extract from an ingested listing read, the k-anonymity floor, the retention rule, and the per-marketplace go/no-go.
---

# Market condition index — what may be aggregated, and under what contract

> **Re-reviewed 2026-09-05, no change.** Drift flagged `listing-ingest.ts`
> for US-3067. The per-marketplace go/no-go this note governs is
> `INGEST_MARKETPLACE_HOSTS`, and that map is untouched. The new
> `SOURCING_MARKETPLACE_HOSTS` feeds one metric label on the scout and
> nothing else: no listing is ingested from a sourcing host, so no
> ShopGoodwill lot can enter the aggregate. The disjointness is asserted in
> `sourcing-scout_test.ts`, which is the half a reader of this note would
> want to check.

US-2709, the decision spike for [[buyer-platform]]'s epic US-2708. Written
**before** anything is built, because the source rows sit under an anti-crawl
contract and a published 90-day deletion promise, and getting this wrong is a
legal problem rather than a bug.

## 1. What the asset is

`lib/listing-ingest.ts` already scores how far a seller's **claimed** condition
sits from GradeThread's **objective** read, per buyer-initiated check, and
persists it on `ingested_listings` (migration 00535). The row is then pruned and
the measurement is discarded after serving one buyer.

The index is that gap, accumulated. Nothing new is collected. **This contract
governs extraction, not collection** — no part of it authorises reading anything
the extension does not already read.

## 2. The three constraints this sits inside

None of these are introduced here. They already exist and this note is bounded
by them.

**The anti-crawl boundary is mechanical.** [[buyer-platform]] §"The ToS boundary
is mechanical, not a promise" enumerates five enforcements in code: one listing
per request with no array form, a marketplace allowlist matched on label
boundaries, the marketplace derived from the URL rather than the body, the
listing page **never fetched** (only images the buyer's own browser already
loaded), and a per-buyer daily row cap. Marketplace terms permit a shopper
reading a page they opened; they do not permit building a crawl.

**The 90-day deletion is a published promise.** `INGEST_RETENTION_DAYS = 90`,
and `data-retention.ts` calls it out as unconditional: the privacy policy says
"Deleted automatically 90 days after the check", with no "if you keep using it"
attached. There is an inline prune on the write path plus a fleet-wide backstop
for the buyer who used the extension once and never returned.

**The US-2148 asymmetry.** Penalise only what a human confirmed; credit on
either. A seller-adverse score is never published from unconfirmed model reads.

## 3. The extraction rule

Extraction happens **at read time**, in the same request that already scored the
listing. The aggregate is incremented and the source row keeps the lifetime it
already has. No child story may extend `INGEST_RETENTION_DAYS` to make
aggregation easier — if the aggregate needs a longer window, it takes it in the
aggregate, never in the identifying row.

### May be extracted

| Field | From | Why it is safe |
|---|---|---|
| `marketplace` | derived from URL | One of eleven allowlisted keys. Not identifying. |
| `brand` | `brand` | A brand, not a party to the listing. |
| category | derived | A garment category, same. |
| price band | `price_cents`, **bucketed** | See below — the raw integer does not survive. |
| `claimed_grade` | `claimed_grade` | The seller's own public claim, as a number. |
| `overall_score` | `overall_score` | Our objective read. |
| `discrepancy` magnitude | `discrepancy` | The measurement itself. |

### Must NOT survive into the aggregate store

`listing_url`, `thumb_url`, `title`, `user_id`, `id`, `matched_search_ids`, any
seller handle, and `price_cents` as a raw value.

**Why price is bucketed rather than carried.** A price is not identifying on its
own and is close to it in combination: marketplace + brand + category + an exact
price to the cent is very often one listing. Banding is what makes the row an
aggregate rather than a re-identifiable record wearing an aggregate's shape.

**Why `user_id` is absent rather than hashed.** A per-buyer hash would still
permit counting how many checks a person ran and on what, which is the browsing
history the 90-day promise exists to delete. The aggregate has no buyer column at
all.

## 4. The k-anonymity floor

**A bucket publishes nothing until it holds 25 observations**, matching
`RESALE_MIN_SAMPLE = 25` in `lib/resale-condition.ts`.

The number is adopted rather than re-derived, and that is the argument for it:
the site already tells buyers "not enough data yet" at 25 in the resale bands,
and two different floors on two public honesty statements is a difference a
reader would have to discover. Below the floor the field is **null with a
not-enough-data message**, never a number with a caveat — the existing rule at
`resale-condition.ts:22-24`.

25 is a floor, not a ceiling on caution. A bucket that is narrow enough to be one
seller's inventory (a rare brand in one category in one price band) should be
widened before it is published; that is a design constraint on US-2710's bucket
keys, recorded here so it is not discovered later.

## 5. What is explicitly out of scope

**No per-seller deficit derived from extension reads.** US-2148's asymmetry
applied to this dataset: an extension read is an unconfirmed model verdict, so
publishing "this seller overstates condition by 1.4 grades" from it would be a
seller-adverse score built from exactly the evidence the asymmetry refuses.

The epic may **credit** a seller from these reads, because crediting is allowed
on either kind of evidence.

**The condition under which that could be revisited**, stated so a later reader
does not have to guess: a per-seller figure becomes arguable only if the reads
behind it are human-confirmed — for instance if a buyer's own confirmation, or a
completed guarantee claim with a reviewer verdict, is the thing counted rather
than the model's read. That is a different dataset with a different story, not a
threshold change on this one.

## 6. Per-marketplace go / no-go

> [!warning] These four rows are a RECOMMENDATION and need the owner's sign-off
> Whether a marketplace's terms permit aggregating buyer-initiated reads is a
> legal reading, not a measurement, and nothing in this repo settles it. What is
> recorded below is the reasoning and the shape of the risk. **A marketplace
> that cannot be cleared is excluded from the index rather than included
> quietly** (US-2709 AC6), so the safe default on an unanswered row is exclusion.

The eleven allowlisted hosts collapse to six marketplaces
(`INGEST_MARKETPLACE_HOSTS`): eBay, Poshmark, Grailed, Mercari, Depop, Vinted.

The argument that applies to all six equally: we do not fetch the listing page,
we read images the buyer's browser already loaded, and what we retain is a
statistic about the *gap between a public claim and our own assessment* — not
listing content. The aggregate contains no marketplace text, no image, no URL
and no identifier.

| Marketplace | Recommendation | Reasoning |
|---|---|---|
| **eBay** | **Go** | We are an API partner with a commercial relationship. The reads are buyer-initiated on pages the buyer opened, and the aggregate carries no listing content. The lowest-risk of the six. |
| **Poshmark, Mercari, Grailed, Depop, Vinted** | **Owner call** | No partner agreement exists for any of them; the relationship is the extension operating in the seller's own browser. The same mechanical argument applies, and "applies" is not "cleared by counsel". |

**Do not read the eBay row as settled either.** It is the strongest case, not a
legal opinion.

**What would make each row answerable**, since AC6 asks for reasoning rather than
assumption: the terms clause that governs automated processing of listing data by
a browser extension acting for a logged-in shopper. That is a specific question
to put to counsel once, covering all six, rather than six separate readings.

**That question is now written and sendable**:
[[counsel-question-extension-terms]]. It is a brief a lawyer can answer without
repo access or a call, and it states what we do with each possible answer,
including that an uncleared marketplace is excluded rather than included
quietly. It does not answer the question and nothing in it changes this table.

## 7. What this note does NOT decide

- The bucket keys and their widths — US-2710.
- Where the aggregate is published and what it says — US-2711.
- How a single buyer read is stated in market context — US-2712.
- The seller-facing comparison — US-2713.

Each of those inherits this contract. None may relax it.

## Related

- [[buyer-platform]] — the anti-crawl contract and the ingest endpoint
- [[data-retention]] — the 90-day prune and its backstop
- [[grade-accuracy-guarantee]] — where confirmed-vs-unconfirmed evidence already
  changes what may be published
