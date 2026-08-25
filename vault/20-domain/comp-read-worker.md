---
title: The comp read worker — demand, not a crawl
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/comp-read-worker.ts
  - services/edge-functions/src/lib/comp-read-demand.ts
  - services/edge-functions/src/routes/jobs-comp-read.ts
  - supabase/migrations/00667_comp_read_queue.sql
reviewed: 2026-08-25
tags: [comps, condition-index, grading, ai-budget, durable-jobs]
summary: Why the comp read queue follows seller demand rather than a catalogue, what the four caps are and why each is that number, how a cell's reads become a published curve, and the two switches that stop it.
---

# The comp read worker — demand, not a crawl

Every comp tool in resale prices by title match. Condition drives a large share
of realized price and nobody quantifies it. This worker reads other people's
listings for condition so a market cell can be fitted to a price-vs-grade slope
([[market-condition-index-contract]] serves the result). It is the thing that spends real money,
so most of its design is about what it refuses to do.

## The queue is fed by demand, and only by demand

`comp_read_demand` is written from exactly one place: `recordCompDemand`, called
from `applyMeasuredCurve` in `condition-value.ts`. That function is the choke
point every condition-adjusted value already passes through — the grade result,
scout's scan, appraisal and prospect, FlipDesk pricing, grade-band pricing — so
recording the cell there means the queue follows what sellers actually touch and
no route has to know the worker exists.

**There is no crawler, and the claim is structural rather than a promise.**
Nothing in the code enumerates a catalogue, and a cell cannot enter the queue
except by a seller asking about it. `comp-read-no-crawl_test.ts` asserts both
against the source, because a crawler nobody calls is still a crawler and would
pass every behavioural test in the suite.

Reads go through `searchBrowseComps`, the eBay Browse API. No marketplace HTML is
fetched or parsed. The one `fetch` in the worker pulls listing photo bytes from
URLs eBay's own API returned, and the test pins the count at one.

## The four caps, and why each is that number

| Constant | Value | Why |
|---|---|---|
| `MAX_IMAGES_PER_READ` | 4 | A gallery leads with the shots that carry condition; the tail is packaging, tags and watermarks. Image five buys noise on every read, forever. |
| `MAX_READS_PER_CELL` | 12 | Equals `MIN_HIGH_CONFIDENCE_READS` in `comp-curve-fit.ts`. Fewer cannot finish a cell; more buys sample for a cell already scorable. A test asserts the two stay equal. |
| `MAX_CELLS_PER_BATCH` | 8 | Bounds one cron tick's wall clock. |
| `CELL_REREAD_COOLDOWN_MS` | 7 days | Matches the curve TTL. Comps drift slowly; re-reading a cell the same afternoon pays to confirm what we hold. |

`MAX_JOB_ATTEMPTS` is 5. That is the cap that stops an unattended reclaim loop
from spending the budget forever: a cell that keeps dying stops being retried.

`READ_TIMEOUT_MS < JOB_STALE_MS < BATCH_STALE_MS` is the durable-jobs contract,
not a preference. A live job that looks stale gets handed to a second worker and
both pay for the same reads.

## Two switches stop it, and they are the same switch

The `comp_read` feature flag is both the gate and the kill target:

- It **ships disabled** (migration 00667) because the US-2842 calibration spike
  has not returned a GO. See [[comp-read-calibration-spike]].
- The `comp_read` AI budget runs at action `kill`, and `FEATURE_FLAG_MAP` maps
  the feature to that same flag, so a breach turns the worker off.

There is deliberately no second place to look.

The budget is checked **before every read**, not once per batch. Eight cells at
twelve reads is ninety-six paid calls; a check at the top would let the whole
batch run past a ceiling it breached on read three.

The seeded daily limit is $5. It is small on purpose: the first real
dollars-per-read number comes from the spike, and a ceiling set before you have
measured the cost should be one you would not mind hitting.

## Reads become a curve at the end of the cell, or the cell keeps the median

`processCell` fits and publishes immediately after its reads are written. Until
that step existed, reads landed in `comp_condition_reads`, curves were served
from `condition_price_curves`, and the two tables never met: the shadow would
have found nothing on every request forever and the US-2849 flip would have had
nothing to flip to. `scripts/check-unwired-modules.mjs` is what caught it, by
noticing `condition-curve-measured.ts` had no production caller.

`decidePublish` **delegates** to `publishable()` in `comp-curve-fit.ts` rather
than re-deriving the bar. Two copies of that arithmetic would drift, and a cell
would eventually publish through whichever copy was softer. The bar is unchanged:
twelve high-confidence reads, and a leave-one-out error at least five percent
better than the plain comp median.

Three refusals here are load-bearing:

- **A cell that cannot publish is the normal case, not an error.** The job still
  completes, the reads are still kept, and the surface keeps serving today's
  median. The worst case for a seller is today's answer.
- **A publish failure never fails the cell.** The reads are already written and
  paid for; a throw would mark the job failed, hand the cell back to the reclaim
  cron and buy the same reads twice.
- **`slug` and `label` are read back and preserved.** A human wrote them and a
  public `/condition-index/<slug>` URL points at them. Upserting the measured row
  without them would blank a live page as a side effect of a background job doing
  well.

## What a row is, and what it is not

`comp_condition_reads` holds a sample: a cell key, a score, a confidence, an
asking price and a hash of the photo set. No seller, no listing id, no URL, no
title, no image bytes. `comp_read_demand` holds a cell and a count, aggregate
across every seller — who asked is not recorded, because a per-seller queue
would leak which sellers are working which brands.

All three queue tables are deny-all operator tables, registered in
`SERVICE_ROLE_ONLY`. See [[service-role-tables]].

A stock-photo read is kept as a row and marked, never dropped: how much of a
cell is catalog imagery is worth knowing, and `comp-curve-fit.ts` is the only
door into a curve and already refuses them.
