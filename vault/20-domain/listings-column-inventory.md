---
title: The listings table — column inventory and read policy
type: contract
status: current
source_of_truth: code
code_refs:
  - scripts/audit-listings-columns.mjs
  - src/test/listings-select-star.test.ts
  - src/test/listing-row-schema-parity.test.ts
  - src/types/database.ts
reviewed: 2026-08-03
tags: [schema, listings, flipdesk, perf]
summary: What the listings table's 91 columns are for, why none of them is provably dead, and the rule for reading them.
---

# The listings table — column inventory and read policy

## Why this note exists

`listings` began as 11 columns and grew one feature at a time. "Is this column
still used?" had no answer short of grepping seventy names by hand, so the
answer was always "leave it" — which is how a table gets to ninety-one columns
without anyone deciding it should.

The numbers here are NOT restated. `node scripts/audit-listings-columns.mjs`
prints the current inventory: every column, the migration that added it, and how
many places reference it. Re-run it rather than trusting a number in prose.

## What the audit found (2026-08-01, US-2177)

Three things, and the first two contradict what the story assumed.

**Ninety-one columns, not the ~52 the story estimated.** The estimate counted
11 base plus 41 `ALTER TABLE` statements; several of those statements add more
than one column.

**Nothing is provably dead.** Exactly one column — `search_vec` — has zero
references in application code, and it is not dead: it is a `tsvector`
maintained by a trigger and read by a GIN index, so Postgres is its only
consumer. Every other column is referenced by name somewhere.

So the "drop the dead columns" half of US-2177 has **nothing to drop**, and no
migration is warranted. That is a finding, not a deferral. The cost of this
table is the WIDTH of its reads, not corpses in it — which is why the wins came
from US-2167's projection work instead.

**`ListingRow` was behind the schema — FIXED 2026-08-03.** Sixteen columns
existed in the database and not in the `ListingRow` type, including ones in
daily use (`platform_fields`, `needs_review`, `quality_score`,
`marketplace_connection_id`, `inventory_sku`). Code touching them cast instead,
which is worse than an untyped field: a cast is an assertion `tsc` trusts, so
the cast became the source of truth and a column renamed in a migration produced
no type error anywhere. All sixteen are now declared.

Drift in that direction is invisible by construction — nothing breaks when a
type describes *less* than the row it stands for, it just stops protecting
anything. So it is guarded rather than reviewed:
`src/test/listing-row-schema-parity.test.ts` parses the migration corpus and
fails in **both** directions (a column with no field, a field with no column).
`search_vec` is the one declared exemption, with its reason.

## Classification

The script buckets every column, and the buckets are the useful part:

- **core lifecycle** — identity, platform, price, status, timestamps. Every read
  needs these.
- **eBay-specific** — condition, policies, category, offer id, sync stamps,
  quality score. Only meaningful on an eBay row.
- **cross-listing / automation** — batch, origin, scheduling, promoted-listing
  fields.
- **metrics** — views, watchers, impressions, CTR, comp price range. Written by
  sync, read by reports.
- **other** — everything a prefix rule cannot place. A large bucket is itself a
  signal that the naming has drifted.

Single-platform fields in the eBay bucket are the obvious candidates for a move
into the existing `platform_fields` jsonb. **Assessed 2026-08-03: do not move
them**, and the reason is specific rather than a preference.

Of the 18 eBay-specific columns, **3 are indexed** (`platform_category_id`,
`platform_offer_id`, `quality_score`) and **7 carry a NOT NULL or a default**
(those three plus `best_offer_enabled`, `item_specifics_override`,
`item_specifics_sources`, `synced_to_ebay_at`). A jsonb move gives up the index
and the constraint on every one of them, and buys back an expression index and a
check constraint that have to be written and maintained by hand.

What it would buy is narrower rows — and that cost is already gone. Reads
project (see the policy below), so a wide table costs nothing a projected read
pays for. Moving them trades real guarantees for a benefit that was already
collected somewhere else.

Revisit only with numbers from prod — row width against actual storage and
`toast` behaviour — not from a dev host.

## The read policy

**A list read of `listings` must project its columns. A bounded single-row read
may use `select("*")`.**

The reason is width, not tidiness: `select("*")` on a 91-column table multiplied
by a page of rows is the cost US-2167 removed. One row is one row.

`src/test/listings-select-star.test.ts` enforces this by **enumeration** — every
`select("*")` on `listings` is declared with its justification, and a new one
fails the build until its author adds it and states why. Three are declared
today: two bounded detail reads (composer, inventory detail) and the account
data export.

The data export is the interesting exemption. It **must** stay `select("*")`:
projecting it would silently omit columns from a record a user is legally
entitled to, and the omission would be invisible — the export would still look
complete. See [[data-retention]].

## Related

- [[postgrest-row-cap]] — the other half of the read contract: bounded pages,
  and never a silent truncation.
- [[sync-source-of-truth]] — which side owns a field once a listing exists on a
  marketplace.
