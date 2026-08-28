# Pipeline XP: making daily reselling work earn progression

Date: 2026-08-28
Status: approved design, not yet implemented

## Problem

A seller who has listed items for months sits at Level 0.

This is not a bug. The reward engine (US-1849, `rewards-engine.ts`) works
correctly. The XP catalog simply has no entry for anything in the FlipDesk
pipeline. Eight call sites in the whole codebase award XP, and none of them
fire when an item is sourced, cataloged, measured, photographed, comped,
drafted, published or sold.

The only listing-adjacent event is `aspects_filled` at 10 XP
(`flipdesk-ai.ts:1026`), and it fires only when the AI fills eBay item
specifics. Every other event needs a paid grade with full photo coverage, a
badge embedded off-platform, a buyer confirming an arrival, or a one-time
marketplace connection.

Level 1 costs 100 XP. After the one-time `marketplace_connected` grant of 40,
a seller needs six AI aspect-fills to see Level 1. Months of real work produce
nothing.

Two secondary problems fall out of the same gap:

- The first tier name change is 900 XP away. Levels 0, 1 and 2 are all
  "Thrifter" (`rewards-levels.ts:50`), so even reaching Level 1 shows no
  visible change.
- The product already has a second, disconnected progression system. The North
  Star job counts items listed per user, weekly and lifetime, with celebration
  emails at 10/25/50/100/250/500/1000 (`jobs-north-star.ts`, RPCs
  `north_star_weekly_counts` and `north_star_lifetime_counts`). The XP engine
  never reads any of it.

## Decisions taken

These were settled in discussion and are not open for re-litigation during
implementation.

1. **Every pipeline action earns XP.** This deliberately relaxes the July 2026
   rule that the catalog is weighted by moat contribution rather than effort
   (see the `project-gamification-design` memory). Effort now earns, but only
   a little.
2. **Grading stays worth multiples of busywork.** A graded item earns roughly
   double an ungraded one. The pull toward attaching a grade must survive.
3. **Existing work is backfilled.** The seller starts at the level their
   history already earned, not at zero.
4. **Backfilled events carry their real dates.** Weekly stats, seasons and
   leaderboards stay honest rather than showing one spike on backfill day.

Everything already settled about the reward system still holds: XP is never
spendable, levels never decrease (`xp_peak`), one ledger serves both the
seller and buyer tracks, and there is no parallel event log.

## XP catalog changes

Seven new event types. Existing entries are unchanged.

| Event | XP | Notes |
|---|---|---|
| `item_cataloged` | 2 | |
| `item_measured` | 2 | |
| `item_photographed` | 3 | |
| `item_comped` | 3 | |
| `item_drafted` | 3 | |
| `item_listed` | 8 | Real published listing only, never a draft |
| `item_sold` | 15 | Real sale row with a price |

Existing grading-route entries, for contrast: `coverage_completed` 25,
`grade_confirmed` 30, `badge_embedded` 50, `integrity_tier_up` 60.

Resulting item economics:

- Listed without a grade: 21 XP.
- The same item graded: 46 XP.
- Listed, graded and sold: 61 XP.

Against the existing curve (`level = floor(sqrt(xp / 100))`), a seller doing
ten items a week without grading reaches Level 1 in week one and Level 3
("Picker") in about five weeks. The same pace with grading reaches Picker in
about two weeks. Level 0 lasts under a day of real work.

None of the seven are added to `GRADING_SPEND_EVENTS`, so they do not carry
the paid gate. They are also not variable-XP events, so `xpForEvent` scores
them straight off the catalog.

## Derivation, not emission

There is no single choke point that changes an item's status. 252 lines across
`services/edge-functions/src/routes/flipdesk-*.ts` write `status`. Wiring
`grantReward` into each one would miss cases at write time and would rot as
routes are added.

Instead, a pure function reads an item plus its related rows and returns which
stages that item has provably reached:

```
pipelineMarksForItem(item, photos, listings, sale) -> PipelineMark[]
```

A sweep grants whatever marks have no event yet. The dedupe key is the item id
joined to the stage name, which `grantReward` already checks via
`hasRewardEvent`, so the sweep is idempotent by construction. Running it a
thousand times awards each stage once.

The same function serves both the backfill and ongoing accrual. There is no
separate one-time migration script to write, test and discard.

## What proves each stage

Only durable marks count. There is no item status-history table, so a stage
that left no trace cannot be recovered.

| Stage | Proof | Timestamp used |
|---|---|---|
| `item_cataloged` | `inventory_items.brand` or `garment_type` is non-null | `created_at` |
| `item_measured` | `inventory_items.measurements` is non-null and non-empty | `updated_at` |
| `item_photographed` | at least one `item_photos` row | earliest photo `created_at` |
| `item_comped` | a `repricing_suggestions` row for the item, or `comped_at` set | that row's `created_at` |
| `item_drafted` | a `listings` row exists for the item | listing `created_at` |
| `item_listed` | a `listings` row with `platform_listing_id` non-null | `listed_at`, else `created_at` |
| `item_sold` | a `sales` row with a price, or `sold_at` non-null | `sold_at` |

Known limitation: `repricing_suggestions.listing_id` is NOT NULL, so comps run
before an item had a listing left no row. Those cannot be backfilled. The
migration adds `inventory_items.comped_at timestamptz` so comps accrue
correctly from here forward, and the comp routes set it. Items that miss
`item_comped` still earn at every other stage.

The current `status` value is not used as proof on its own. Items move
backward (returned, relisted) and a single enum value cannot show which
earlier stages actually happened.

## The sweep

`sweepPipelineRewards(userId)` in a new
`services/edge-functions/src/lib/rewards-pipeline.ts`:

1. Load the user's items with their photos, listings, sales and repricing rows.
   Every query is scoped by `.eq("user_id", userId)` per US-268. The
   service-role client bypasses RLS, so the scoping is the only protection.
2. For each item, call `pipelineMarksForItem`.
3. Grant missing marks through `grantReward`, with the reference id set to the
   item id joined to the stage name and `occurredAt` set to the derived
   timestamp.
4. Return a summary: marks granted, XP added, level before and after.

Triggers:

- On load of the FlipDesk pipeline page and the Rewards page, throttled to one
  sweep per user per five minutes. This is what makes working feel like it
  counts.
- A nightly cron job route (`jobs-rewards-sweep.ts`) as the floor, so nothing
  waits on a page visit. It follows the existing job-secret pattern used by
  the other `jobs-*.ts` routes.

The throttle timestamp lives on `user_reward_state`, added by the migration as
`last_pipeline_sweep_at timestamptz`.

## Backfill

The first sweep for a user is the backfill. No separate code path.

Because events are stamped with derived historical timestamps, a seller's
history lands across the months it happened in. The `reputation_events` log,
weekly counts and seasonal stats all read correctly afterward.

## Daily cap on busywork

A ceiling on pipeline XP per event date, read from a `system_settings` key
`rewards.pipeline_daily_xp_cap` defaulting to 300. Grading-route events are
never capped.

Applying the cap per `occurred_at` date rather than per wall-clock day makes
the backfill work correctly for free: months of history spread across months
of dates and barely touch the ceiling, while a 500-item CSV import dated today
hits it immediately.

The setting follows the `rewards.disabled_mechanics` pattern: no seed row, an
absent key means the default, and an unparseable value degrades to the default
rather than throwing inside the grant primitive.

## Quiet mode and the arrival screen

A backfill will cross several levels at once. Firing a level-up popup, a
notification and an email for each one would be noise, not celebration.

`grantReward` gains an optional `quiet` flag. When set, XP is granted and
badges are awarded as normal, but per-level celebrations and emails are
suppressed. The sweep sets it whenever it grants more than one level's worth
in a single run.

The Rewards page then shows one arrival state on the next visit: the level
reached, the tier name, and every badge earned, in a single celebration. This
is the moment the whole change exists to produce, and it should happen once
and land hard rather than fifteen times and mean nothing.

## Money safety

Crossing XP milestones grants real value through `grantTangibleRewards`.

Verified during design: `rewards-tangible.ts` already enforces a global
monthly USD cap, a per-user monthly cap and a per-user lifetime cap
(`budgetDecision`), plus per-milestone platform-wide monthly and lifetime
issue caps. A large backfill cannot drain the reward budget. The separate
`rewards_tangible` kill switch still governs whether any payout happens at
all, and is read fail-closed.

No change is needed here. The caps are the reason a backfill is safe to run.

## North Star reconciliation

The North Star lifetime milestones and pipeline XP now measure the same
behavior. Both stay, because they serve different surfaces, but they must stop
sending two celebration emails for one event.

`jobs-north-star.ts` keeps ownership of the items-listed milestone emails.
Pipeline XP level-ups do not send their own email when a North Star milestone
email went out for the same user on the same day.

## Tenant isolation

Every read in the sweep is scoped by `user_id` on `inventory_items`, which has
its own `user_id` column. Related rows are reached through owner-verified
parent items, never by an id from a request body. `listings` has no `user_id`
column, so listing rows are loaded by `inventory_item_id` from the already
owner-scoped item set.

Per the tenant-isolation skill, the new sweep route gets a case in
`tenant-isolation_test.ts`.

## Files touched

- `supabase/migrations/00679_pipeline_reward_events.sql` (new): widen the
  `reputation_events_event_type_check` constraint with the seven new types,
  add `inventory_items.comped_at`, add
  `user_reward_state.last_pipeline_sweep_at`. Idempotent, with the self-record
  footer.
- `services/edge-functions/src/lib/schema-version.ts`: bump
  `EXPECTED_SCHEMA_VERSION` to `"00679"` in the same commit.
- `services/edge-functions/src/lib/rewards-engine.ts`: seven new
  `RewardEventType` members and `REWARD_XP_CATALOG` entries; the `quiet`
  option on `grantReward`.
- `services/edge-functions/src/lib/rewards-pipeline.ts` (new):
  `pipelineMarksForItem` (pure) and `sweepPipelineRewards`.
- `services/edge-functions/src/routes/jobs-rewards-sweep.ts` (new): nightly
  cron, job-secret gated.
- `services/edge-functions/src/routes/rewards.ts`: throttled on-demand sweep.
- `src/pages/rewards.tsx`: the arrival state.
- Comp routes: set `comped_at`.
- Tests as below.

## Testing

- `pipelineMarksForItem` is pure and unit-tested with no database: each stage's
  proof present and absent, an item with photos but no listing, a listing with
  no `platform_listing_id` (drafted but not listed), a returned item, an item
  with a repricing row and one without.
- Idempotency: running the sweep twice over the same fixture grants each mark
  exactly once.
- Cap: events dated the same day stop at the ceiling; events spread across
  dates do not.
- Level math: the worked examples in this document (21, 46 and 61 XP per item,
  Picker at roughly five weeks ungraded and two weeks graded) are asserted so
  a future catalog edit that silently changes the pacing fails a test.
- Tenant isolation: a sweep for user A grants nothing from user B's items.
- Existing reward engine tests must still pass unchanged.

## Out of scope

- Changing the level curve or the tier thresholds. The new catalog makes the
  existing curve reachable; changing both at once would make the pacing
  impossible to reason about.
- Quests, seasons and leaderboards. Unchanged by this work.
- iOS and Android parity for the arrival screen. The XP accrues for all
  clients because it is derived server-side, but the celebration UI ships on
  web first and gets its own story.
