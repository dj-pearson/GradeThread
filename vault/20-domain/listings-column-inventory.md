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
reviewed: 2026-08-27
tags: [schema, listings, flipdesk, perf]
summary: What the listings table's ninety-odd columns are for, why none of them is provably dead, and the rule for reading them.
---

# The listings table — column inventory and read policy

> **Re-reviewed 2026-08-27.** Drift flagged `src/types/database.ts` a fourth
> time, and this time a `listings` column really did move: migration 00678
> (US-2956) adds **`description_blocks jsonb`**, nullable, no default. It is the
> ordered list of named blocks that `listing_description` is now RENDERED FROM,
> and it belongs in the *other* bucket.
>
> Two things about it change how this note's read policy applies:
>
> - **`listing_description` is not going away, and is no longer authored.** It
>   stays because full-text search (00016), fuzzy search history (00248) and
>   return attribution (00655) all read it. It is derived state now: one edge
>   function, `renderAndPersistDescription`, writes both columns in a single
>   update. Anything that writes `listing_description` on its own is a bug.
> - **NULL is a designed state, not missing data.** It means the listing
>   predates blocks, and it is the signal to parse the legacy string on open.
>   Do not backfill it and do not treat it as an integrity gap in an audit.
>
> The column is wide and read rarely — only the composer and the renderer want
> it — so the projection rule in the read policy below applies to it with more
> force than to most: never pull it into a list query.

> **Re-reviewed 2026-08-25.** Drift flagged `src/types/database.ts` a third
> time, and a third time nothing about `listings` moved: US-2851 added scout
> ceiling fields, US-2852/2853 added seller listing defaults and quiet hours,
> and US-2886 added `SourcerRow` — all on other tables in the same file.
>
> **Re-reviewed 2026-08-22.** Drift flagged `src/types/database.ts`, and the
> change was on a DIFFERENT TABLE: US-2777 added `lister_locales` to
> `FlipdeskSettingsRow`. Nothing about `listings` moved. Recorded rather than
> silently bumped, because `database.ts` types every table in the schema and so
> will flag this note on any of them — a reader who assumes the flag means a
> `listings` column changed will go looking for something that is not there.

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
than one column. It is **94 as of 2026-08-19** — `category_candidates` (00540)
and `aspect_coverage` (00541) landed on 2026-08-07, and `demand_terms_detail`
(00621, US-2678's sibling US-2675) on 2026-08-19 — and that direction is the only
one it moves in, which is why the count belongs in the script's output and not in
this sentence.

`demand_terms_detail` is worth one line here because it is the second column
holding the same list: `demand_terms` (text[], 00154) keeps the flat words for
the listing prompt and the title meter, and the jsonb one adds each term's
provenance. That is deliberate rather than an oversight — every existing reader
wants the flat array, and NULL in the new column means "the source was never
recorded", which is not the same claim as "these came from active listings".

**Nothing is provably dead.** The script reports zero columns with no reference
at all, and that is not the same as every column being read. `search_vec` is
still the one nothing in application code touches: its only two references are
the exemption in `src/test/listing-row-schema-parity.test.ts` and the comment in
`src/types/database.ts` saying why it is absent from the type, both written by
the 2026-08-03 fix below. It is a `tsvector` maintained by a trigger and read by
a GIN index, so Postgres remains its only consumer. Every other column is
referenced by name in code.

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

Of the eBay-specific set — the script's own bucket plus the eBay-only fields it
files under *other* (`best_offer_enabled`, `item_specifics_override`,
`item_specifics_sources`, the three policy ids) — **3 are indexed**:
`platform_category_id`, `platform_offer_id` and `quality_score`. A fourth,
`synced_to_ebay_at`, sits in the predicate of
the partial index that drives the scheduled-publish worker. A jsonb move gives
up all four outright and buys back an expression index that has to be written
and maintained by hand.

The constraint half of that argument is thinner than this note claimed until
2026-08-12. Only **2 of these columns carry a NOT NULL or a default** —
`best_offer_enabled` and `item_specifics_sources`, both `NOT NULL DEFAULT` in
their `ADD COLUMN`. The note previously said seven, counting
`platform_category_id`, `platform_offer_id`, `quality_score`,
`synced_to_ebay_at` and `item_specifics_override`; all five are plain nullable
columns with no default in 00052/00476, so the claim was wrong when it was
written rather than having drifted. The decision below still holds, but it
rests on the indexes and on the width benefit already being collected, not on
constraints that were never there.

What it would buy is narrower rows — and that cost is already gone. Reads
project (see the policy below), so a wide table costs nothing a projected read
pays for. Moving them trades real guarantees for a benefit that was already
collected somewhere else.

Revisit only with numbers from prod — row width against actual storage and
`toast` behaviour — not from a dev host.

## The read policy

**A list read of `listings` must project its columns. A bounded single-row read
may use `select("*")`.**

The reason is width, not tidiness: `select("*")` on a table this wide multiplied
by a page of rows is the cost US-2167 removed. One row is one row.

`src/test/listings-select-star.test.ts` enforces this by **enumeration** — every
`select("*")` on `listings` is declared with its justification, and a new one
fails the build until its author adds it and states why. **Two** are declared
today: the composer's bounded single-row read (`.maybeSingle()`) and the account
data export. There were three until US-2362 deleted `src/pages/inventory-detail.tsx`
on 2026-08-03 and its declaration went with the page — the guard names files as
strings, so a stale declaration fails with ENOENT rather than passing quietly.

The data export is the interesting exemption. It **must** stay `select("*")`:
projecting it would silently omit columns from a record a user is legally
entitled to, and the omission would be invisible — the export would still look
complete. See [[data-retention]].

## Related

- [[postgrest-row-cap]] — the other half of the read contract: bounded pages,
  and never a silent truncation.
- [[sync-source-of-truth]] — which side owns a field once a listing exists on a
  marketplace.
