---
title: Pipeline XP — derived from item state, swept, capped per date
aliases: [pipeline XP, item stages, XP backfill, rewards sweep]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/rewards-pipeline.ts
  - services/edge-functions/src/routes/jobs-rewards-sweep.ts
  - services/edge-functions/src/routes/rewards.ts
reviewed: 2026-08-28
tags: [rewards, gamification, flipdesk, seller, contract]
summary: The seven FlipDesk pipeline stages earn XP that is DERIVED from durable item state rather than emitted by the routes that move an item; a sweep grants what is missing, the same code path serves the one-time backfill, and the anti-farming bound is an XP ceiling per occurred_at date rather than a paid gate.
---

# Pipeline XP

Seven stages of the FlipDesk pipeline award XP: `item_cataloged` (2),
`item_measured` (2), `item_photographed` (3), `item_comped` (3), `item_drafted`
(3), `item_listed` (8), `item_sold` (15). The catalog itself lives in
[[reward-ledger]]; this note is about how the events get written, which is not
how any other reward event gets written.

## Why derived and not emitted

Every other rewardable act calls `grantReward` at its source. The pipeline
cannot: **252 lines across `services/edge-functions/src/routes/flipdesk-*.ts`
write `inventory_items.status`**, there is no choke point to wrap, and a hook set
assembled by hand would be incomplete on the day it shipped and would rot as
routes were added.

The failure mode is what settles it. A missing hook is **invisible** — it looks
exactly like a seller who did not do the work, which is indistinguishable from
the bug this whole feature exists to fix.

So `pipelineMarksForItem` reads the stages off evidence that survives, and a
sweep grants whatever has no event yet. One consequence worth stating plainly:
**that function IS the backfill.** There is no separate one-time script.

## What proves each stage

Only durable marks count. There is no item status-history table, so a stage that
left no trace cannot be recovered.

| Stage | Proof | Dated from |
|---|---|---|
| `item_cataloged` | `brand` or `garment_type` non-blank | item `created_at` |
| `item_measured` | `measurements` jsonb non-empty (`{}` and `[]` do not count) | item `updated_at` |
| `item_photographed` | any `item_photos` row | earliest photo `created_at` |
| `item_comped` | a `repricing_suggestions` row, or `inventory_items.comped_at` | earliest of the two |
| `item_drafted` | any `listings` row | earliest listing `created_at` |
| `item_listed` | a `listings` row with non-blank `platform_listing_id` | `listed_at`, else that listing's `created_at` |
| `item_sold` | a `sales` row with `sale_price > 0` | `sold_at`, else `sale_date` |

Three things this table is easy to get wrong:

- **`listings.listed_at` is NOT NULL DEFAULT now()**, so it is populated on
  drafts too and cannot be the published marker. `platform_listing_id` is the
  only column that means a marketplace accepted the listing.
- **Listed and sold date by PREFERENCE, not by earliest-of-the-pair.** A
  listing's `created_at` usually precedes its `listed_at`; taking the earlier
  would date every publication to its draft and erase the draft-to-live gap.
- **`inventory_items.status` is never proof.** Items move backward — returned,
  relisted, archived — and one enum value cannot say which earlier stages
  happened.

Each stage pays at most once per item however many listings, photos or comp runs
it has: cross-posting one item to four marketplaces is one item's work.

## The permanent comps gap

Comps that predate migration 00679 **cannot be backfilled**.
`repricing_suggestions.listing_id` is NOT NULL, so a comp run before the item had
a listing wrote no row, and `comped_at` did not exist yet. Affected items lose
`item_comped` (3 XP) and keep every other stage. This is a known, permanent gap,
not a bug to investigate.

## Idempotency is structural

The dedupe key is `<itemId>:<stage>`. `reputation_events` carries
`uq_reputation_event_ref`, a UNIQUE index on
`(user_id, event_type, reference_id)` from migration 00417, and the emit upserts
with `ignoreDuplicates`. A re-run is a no-op **at the database level** — not
because the sweep is careful.

## The cap is per occurred_at date, and that is the whole trick

Pipeline XP is bounded by `rewards.pipeline_daily_xp_cap` (a `system_settings`
key, default 300, degrading to the default on junk exactly like
`rewards.disabled_mechanics`). Grading-route events are never capped.

Applying it per **`occurred_at` date** rather than per wall-clock day is what
makes the backfill work with no special case: a seller's months of history spread
across months of dates and barely touch the ceiling, while 500 items imported and
dated today hit it immediately. Planning is chronological, so on a day at its
limit the seller's earliest work is what earns.

## The sweep runs three ways

1. **On the rewards screen.** `GET /api/rewards/state` sweeps first, throttled to
   one attempt per five minutes, so working feels like it counts.
2. **On the FlipDesk pipeline page**, via the same endpoint and the same throttle.
3. **Nightly** at 06:30 UTC (`/api/jobs/rewards-sweep`), which is the floor and
   the thing that delivers the backfill to a seller who never opens Rewards.

The nightly queue is `user_reward_state.last_pipeline_sweep_at` **ascending,
nulls first** — never-swept at the front, then longest-unswept. Sweeping stamps
the row, which moves that seller to the back. Coverage is a property of the
ordering rather than of a cursor surviving, so there is no cursor to lose. It
needs every seller to HAVE a row, which migration 00680 seeds and
`markSweepAttempted`'s upsert maintains.

Two stamping rules keep the queue honest: the marker is written on every sweep
**attempt** including one that grants nothing, and it is written for a seller
whose sweep **threw**. Skip either and a broken or empty account wedges the front
of the queue and starves everyone behind it.

XP is scoped to the id that owns the items — `c.get("userId")`, never
`workspaceOwnerId`. A level is a personal standing, the same call
`routes/rewards.ts` makes throughout. See [[reward-ledger]].
