# Carrier numbers, and where they came from

Every number in this directory was read off the **carrier's own published
rule**, and the row records the URL and the date it was read.

## Why the discipline exists

`src/lib/ebay-fee-schedule.ts` once shipped a real-but-wrong number taken from
a secondary source. It looked right, it was in the right units, and it was
wrong — which is the failure mode a plausible number has and a missing one does
not. So: **nothing here is edited from memory, from a search summary, or from a
blog that quotes the carrier.** If the published rule contradicts a constant in
the code, the published rule wins and the code changes.

A search result that *states* the rule correctly is still not the rule. It goes
in this directory only when a page the carrier publishes has been read.

## `usps-dim-weight-CONFIRMED.csv`

Read 2026-08-22 from USPS Postal Explorer, which is the online Domestic Mail
Manual:

- **Priority Mail** — [DMM 123](https://pe.usps.com/text/dmm300/123.htm):
  *"Postage for parcels addressed for delivery to Zones 1-9 and exceeding 1
  cubic foot (1,728 cubic inches) is based on the actual weight or the
  dimensional weight"*, dividing by **139** and rounding up to whole pounds.
  Nonrectangular parcels multiply cubic inches by **0.785** first.
- **USPS Ground Advantage** — [DMM 283](https://pe.usps.com/text/dmm300/283.htm):
  the same three numbers — 1,728 cubic inches, divisor 139, zones 1-9, and the
  0.785 nonrectangular factor.

Both services agree, which is worth stating because it is the kind of thing
assumed rather than checked. They were read separately.

### What was NOT confirmed

`https://pe.usps.com/text/dmm300/103.htm` and `.../253.htm` were tried first and
neither carries the rule — 253 is Parcel Select Commercial, not Ground
Advantage. Recorded so the next person does not repeat the two misses.

Maximum weights and length-plus-girth limits are **not** in this file. They were
not read from a primary source, so they are not written down as though they
were.

## `usps-rates-CONFIRMED.csv`

Read 2026-08-22 from [USPS Notice 123, the published Price
List](https://pe.usps.com/text/dmm300/Notice123.htm), table *USPS Ground
Advantage-Retail*.

**Effective date: July 12, 2026**, printed on the notice itself
(*"Notice 123 - Effective July 12, 2026"*). This is the real `effectiveFrom`
the design asked for — USPS does publish one, unlike the eBay fee schedule,
where inventing a freshness stamp was refused.

### Read this before using these numbers

The page is a dense multi-service rate table, and it was read through a
summarising fetch rather than parsed from the source PDF. That is a lossier
channel than reading a single published rule, so the CSV carries a
`confidence` column and says which is which:

- `cross_checked` — the cell was asked for twice, in separately worded
  requests, and both reads agreed. Zone 4 at 1 lb ($10.60) and 2 lb ($13.00),
  and Zone 1&2 at 1 lb ($9.55). The zone relationship is also the right shape:
  the nearer zone is cheaper.
- `single_read` — read once. Plausible and unconfirmed.

**Do not price against a `single_read` row without checking it.** The
discipline in this directory exists because a real-but-wrong number is the
dangerous kind, and a table transcribed once by a model is exactly where one
would come from.

### What is NOT here

The published table continues to 70 lb and the bands above 5 lb are unread.
Priority Mail is unread entirely. Zones other than 4 and 1&2 are unread. None
of that is guessed at — it is simply absent, which is the correct state for a
number nobody has looked up.
