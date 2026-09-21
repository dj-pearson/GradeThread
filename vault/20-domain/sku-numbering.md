---
title: SKU numbering contract
aliases: [sequential SKU, SKU odometer, flipdesk_sku_sequences]
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00802_flipdesk_sku_sequences.sql
  - supabase/migrations/00803_assign_sku_trigger.sql
  - supabase/migrations/00804_sku_sequence_rpcs.sql
  - scripts/check-sku-sequences.mjs
  - src/lib/sku-presets.ts
  - src/hooks/use-sku-sequence.ts
  - src/components/flipdesk/sku-auto-hint.tsx
reviewed: 2026-09-20
tags: [flipdesk, sku, inventory, contract]
summary: How a blank SKU is filled from a per-tenant odometer, what counters means, and the five invariants that keep SKUs unique inside a tenant.
---


> [!note] Re-reviewed 2026-09-20. Drift on `scripts/check-sku-sequences.mjs`
> twice (US-3419, then US-3432). Both changed how it CONNECTS, not what it
> proves: it takes `--dsn` now rather than only `docker exec`. This note calls
> it "Proof against a real Postgres", which is more true than when it was
> written -- the three fixtures (the J9999 to K0000 carry, Z9999 reporting
> exhaustion, a workspace member drawing from the owner's counter) are
> unchanged and all three were run against a real cluster on 2026-09-20.

# SKU numbering contract

A tenant defines a SKU shape once. Every item they create afterwards with a
blank SKU gets the next value in that shape, from any client, with no
duplicates inside the tenant.

Built by US-3414 through US-3419. The design argument is in
`docs/superpowers/specs/2026-09-14-sequential-sku-design.md`.

## The five things to know before changing anything

### 1. `counters` is the NEXT value to issue, not the last one issued

`flipdesk_sku_render(pattern, counters, today)` **is** the next SKU. Nothing
advances first. Seeding a tenant whose highest SKU is `1031` stores `{1032}`.

Every layer depends on this reading: the trigger renders before it advances, the
preview's first element is the un-advanced render, and the settings screen shows
`render(counters)` as "Next". Flipping the convention silently reissues one
number per tenant.

### 2. The carry rule has exactly one home, and a guard keeps it there

`public.flipdesk_sku_advance` decides when `J9999` becomes `K0000`. There is no
TypeScript, Swift or Kotlin copy, and `src/test/sku-odometer-single-home.test.ts`
fails the build if one appears. The settings preview calls the
`flipdesk_sku_preview` RPC rather than computing anything.

This is not caution for its own sake. The grading rounding rule lives at three
sites in this repo and has to be changed in lockstep; that scar is why this one
does not.

### 3. The sequence never wraps

When the leftmost wheel overflows, `flipdesk_sku_advance` returns NULL and the
sequence is **exhausted**. Wrapping would hand out a number the tenant already
used, which is the single failure the whole feature exists to prevent.

### 4. Exhaustion leaves a NULL SKU; it does not fail the insert

An exhausted sequence sets `exhausted = true` and returns the row with `sku`
still NULL. The item saves.

This was chosen deliberately over raising: an unsaved item is worse than an
unnumbered one for a seller mid photo session, who cannot diagnose a 23505. The
price is that blank SKUs appear in silence, and it is paid by two banners with
identical wording, on the settings screen and in the inventory shell
(`SkuExhaustedBanner`). **If you ever remove one of those banners, this trade
stops being honest.** The inventory one can be dismissed, but only for the
browser session, and it asks about the OWNER's row rather than the acting
member's -- a dismissal that outlived the session, or a banner keyed on the
actor, would quietly re-open the silence this pays for.

### 5. The tenant is `inventory_items.user_id`, which is the workspace OWNER

Never `auth.uid()`. `services/edge-functions/src/middleware/workspace.ts:24-27`
is where that column is established as the owner rather than the actor, and the
`tenant-isolation` skill owns the rule itself (procedure lives in skills, not
here). On a solo account the two are the same person, so a test
that only covers solo accounts cannot tell a correct trigger from a broken one —
`scripts/fixtures/sku-assignment.sql` inserts as a MEMBER of somebody else's
workspace for exactly that reason.

## What is NOT changed by any of this

Uniqueness predates the feature and is untouched:
`idx_inventory_items_user_sku` in `00008_flipdesk_schema.sql` is
`UNIQUE (user_id, sku) WHERE sku IS NOT NULL`. Two tenants may hold the same
string; one tenant may not hold it twice.

A SKU the caller supplies is never overwritten, under any setting, and it costs
no number — the trigger bails before it claims.

Existing rows are never renumbered. The seed READS `inventory_items` to find
where to start and writes nothing.

## Where the pieces live

| Piece | Where |
|---|---|
| Table + seven odometer functions | `00802_flipdesk_sku_sequences.sql` |
| `BEFORE INSERT` trigger | `00803_assign_sku_trigger.sql` |
| preview / seed / save RPCs | `00804_sku_sequence_rpcs.sql` |
| Presets and segment types | `src/lib/sku-presets.ts` |
| Settings screen | `/dashboard/flipdesk/settings/sku` |
| Proof against a real Postgres | `scripts/check-sku-sequences.mjs` |

The table carries a SELECT policy and **no write policy at all**. A client that
can move `counters` backwards can mint duplicate SKUs, so every write goes
through `flipdesk_sku_save`, which validates first.

## The validator's messages are the contract

`flipdesk_sku_validate` returns sentences written for a seller, and the settings
screen shows them verbatim (`src/lib/sku-rpc-message.ts` explains why this
bypasses the usual `toastError` path). Rewording one in the UI gives a single
rule two phrasings, which is how somebody ends up unable to act on either.

## Two sharp edges that bit during the build

- `lpad(x, 0, '0')` returns the **empty string**, not `x`. An unpadded number
  segment needs its own branch in `render`, and it has one.
- A trigger that never writes its advance back **still** produces distinct SKUs
  in a bulk insert, because the collision skip covers for it. The assertion that
  actually catches that bug is the counter read, not the distinct count.
  `scripts/check-sku-sequences.mjs` records this so nobody deletes the load-
  bearing half.

## Related

- [[sync-source-of-truth]] — `listings.inventory_sku` is a snapshot of this
  column taken at publish time, and its ownership rules live there, not here.
- [[service-role-tables]] — the neighbouring case: tables the service role
  reaches past RLS, and what has to be registered when one is added.
- [[migrations-process]] — the US-1108 triple these three migrations follow.
