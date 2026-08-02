---
title: The listings table — column inventory and read policy
type: contract
status: current
source_of_truth: code
code_refs:
  - scripts/audit-listings-columns.mjs
  - src/test/listings-select-star.test.ts
  - src/types/database.ts
reviewed: 2026-08-02
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

**`ListingRow` is behind the schema.** Sixteen columns exist in the database and
not in the `ListingRow` type in `src/types/database.ts` — including ones that
are used heavily (`platform_fields`, `needs_review`, `quality_score`,
`marketplace_connection_id`, `inventory_sku`). Code that touches them does so
through an untyped cast, so a rename or a type change is invisible to `tsc`.
The audit script's cross-check is what surfaces this; run it after any migration
that adds a column.

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

Single-platform fields in the eBay bucket are the candidates for a move into the
existing `platform_fields` jsonb, if that is ever worth doing. It is not
obviously worth doing: jsonb costs typing and indexability, and the columns are
cheap while reads are projected.

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
