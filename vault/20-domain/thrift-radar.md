---
title: Thrift Radar — crowdsourced sourcing intelligence
type: contract
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/routes/flipdesk-scout.ts
  - services/edge-functions/src/lib/scout-decision.ts
  - services/edge-functions/src/lib/radar-privacy.ts
  - services/edge-functions/src/lib/radar-events.ts
  - services/edge-functions/src/lib/radar-venues.ts
  - services/edge-functions/src/lib/radar-venue-registry.ts
  - services/edge-functions/src/lib/radar-aggregates.ts
  - services/edge-functions/src/lib/radar-aggregate-engine.ts
  - services/edge-functions/src/routes/flipdesk-radar.ts
  - services/edge-functions/src/routes/jobs-radar-aggregate.ts
  - supabase/migrations/00547_radar_scan_events.sql
  - supabase/migrations/00548_radar_venues.sql
  - supabase/migrations/00549_radar_aggregates.sql
  - src/components/settings/radar-contribution-card.tsx
  - ios/GradeThread/Prospect/RadarConsent.swift
  - src/pages/flipdesk/scout.tsx
reviewed: 2026-08-07
tags: [radar, flipdesk, scout, privacy, consent, contract]
summary: Radar turns Prospect scans into venue-level supply intelligence; contribution and viewing are separate consents, no precise coordinate survives venue resolution, and the k-anonymity floor is a server-side guarantee rather than a display preference.
---

# Thrift Radar — crowdsourced sourcing intelligence

Radar is the network layer over the existing Prospect scan: every in-field scan
already carries brand, an estimated grade and a buy/pass verdict
([[grading-scale-and-weights]] for the grade, `lib/scout-decision.ts` for the
verdict), so adding **where** turns a private tool into a live map of secondhand
supply. Epic US-1860; built by US-1861…US-1867.

This note is the part that is a **rule** rather than a plan. The stories describe
what to build; what follows constrains how, and does not expire when they close.

## The eight rules

**1. Two consents, never one.** Viewing Radar and contributing to Radar are
separate decisions. Opening the map must never enrol the viewer as a contributor,
and the contribution toggle must be reachable and revocable without giving up the
map. A single "Radar" switch collapses a read into a write and is refused.

**2. Contribution is opt-in and defaults OFF.** On every client. A scan emits a
Radar event only while the toggle reads true; revoking stops emission and drops
anything still batched on the device — the same corollary
[[extension-telemetry-consent]] arrived at, for the same reason: a later opt-in
must not ship activity from the period the user said no to.

**3. Never widen an existing toggle to cover Radar.** Location is a new kind of
data, so it gets a new toggle, new storage key and new lines in the privacy
policy and the iOS App Privacy declarations. Folding it under an existing
insights/telemetry switch makes a sentence someone already read become false,
retroactively. This is [[extension-telemetry-consent]] rule 1 applied to a second
surface, and it is the rule most likely to be "optimised away" by a story that
just wants a scan to carry a lat/lng.

**4. No precise coordinate survives venue resolution.** Coordinates exist for
exactly one purpose — picking the venue — and the analytical row keeps the
`venue_id` (or, while unresolved, a coarse geohash cell), never the raw fix. A
retained coordinate trail is a movement history of a named person, which is a
different product from the one anyone consented to.

**5. The contributor key is rotating and de-identified.** The analytical path
carries no readable `user_id`. Use the salted-digest approach
[[garment-passport-privacy]] already established (`minimizeLinkageRef()`, salt
from env) with rotation, so contributions can be counted as distinct without
being re-joined to a person or followed across windows.

**6. The k-anonymity floor is enforced server-side.** A venue × window aggregate
is served only above K distinct contributors (configurable, default 3). Below the
floor the endpoint returns nothing — not a redacted payload the client is trusted
to hide. K is a privacy guarantee, so lowering it is a policy change, not a
tuning knob, and a below-floor venue needs a test proving the response is empty.
The UI's honest empty state ("not enough data here yet") is a consequence of the
server's silence, not a substitute for it.

**7. The personal layer is free, opt-in-independent, and must work at n=1.** A
user's own sourcing history per venue is their own data: it requires no
contribution consent, is available on every plan, and must be useful with zero
network data anywhere near them. This is the cold-start answer — a Radar that is
blank until strangers show up never gets the strangers. Network layers (map
hotness, venue detail, route planner) are Pro+, gated at the aggregates endpoint
and not only in the UI; see [[buyer-platform]] for why an advertised allowance
nothing reads is decoration.

**8. Contribution is fire-and-forget.** A Radar write that fails, times out or is
rate-limited must never slow or degrade the scan result the user is standing
there waiting for. The scan is the product; Radar is a by-product.

## What the code looks like today

`POST /api/flipdesk/scout/prospect` now accepts an **optional `lat`/`lng`**, and
US-1861 is the commit that added it — together with the toggle, the consent copy
and the discard, exactly as this note required. The shape that landed:

- **`radar-privacy.ts` is pure and env-free** (geohash coarsening, epoch, the
  rotating digest, the row builder). Its test asserts the row's KEY SET, not the
  absence of a field, so adding a coordinate column would fail rather than pass
  unnoticed.
- **`radar-events.ts` is impure and fire-and-forget.** Every gate — deployment
  kill-switch, `users.radar_contribute`, an unusable fix — lives inside
  `emitRadarScanEvent`, so the call site in `flipdesk-scout.ts` is one unawaited
  line and cannot forget one of them.
- **The consent is `users.radar_contribute`** (00547), default false, written by
  the web card and by iOS `RadarConsent`. iOS additionally keeps a local mirror,
  because consent before collection means not calling CoreLocation at all while
  the answer is no — not calling it and discarding the result.
- **The precision knob is bounded by the schema.** `radar_privacy
  .geohash_precision` is clamped in code and capped at 7 characters by a CHECK on
  the column, so rule 4 survives a config edit by someone who has not read this
  note.

US-1862 filled in the `venue_id` that 00547 left pointing at nothing:

- **`radar_venues` (00548) is the registry.** Display name, chain tag, centroid,
  resolution cell, status candidate / confirmed / merged. A partial unique index
  on `(geohash, chain) WHERE status <> 'merged'` is what makes later scans
  converge onto one candidate rather than each minting their own, and what makes
  two concurrent scans safe.
- **Same pure/impure split as US-1861.** `radar-venues.ts` is pure (chain
  normalization, cell geometry, nearest-venue matching, candidate drafting, merge
  planning) and needs no env dance; `radar-venue-registry.ts` holds the reads,
  the insert and the merge writes, and never throws — a failure returns
  "unresolved" and the event keeps its cell, which is the state
  `radar_scan_events_located` was written to allow (rule 8).

### A centroid that is not an exception to rule 4

An auto-created venue's `lat`/`lng` is the **centre of a geohash cell**, never a
contributor's fix. Every scan in the cell yields the identical pair, so the
centroid states where the cell is and nothing about where a person stood; the
signature enforces it, because `candidateVenueDraft(cell)` has no coordinate
parameter to pass a fix through. Precision is only ever bought from a source
allowed to be precise — a human placing the venue, or the Places enrichment the
`place_*` columns are reserved for — and `centroid_source` (`cell` | `user` |
`places`) says which, so the guarantee stays checkable rather than remembered.

Two thresholds that are easy to confuse, and must not be:
`radar_venues.confirm_min_observations` promotes a candidate to confirmed and
counts **contributions**, so one enthusiastic person can trip it;
`radar_privacy.k_anonymity_floor` decides whether an aggregate may be **served**
and counts **distinct contributor keys**. They live in separate `system_settings`
rows on purpose — tuning and policy should not share an edit.

Chain is a shared label on distinct places. `normalizeChain` folds "Goodwill
Store #123" and "Goodwill Industries" to `goodwill`, and `planVenueMerges`
refuses to merge across chains: a Goodwill and a Savers in one strip mall are two
stores, and folding them destroys the per-venue identity the registry exists to
create. A merged loser is tombstoned (`status='merged'`, `merged_into_id` set),
never deleted, so an id already written to an event cannot dangle — and events
move to the survivor **before** the loser is tombstoned, so a crash between the
two writes leaves observations on a live venue.

Every scout route is already tenant-scoped the standard way
(`c.get("workspaceOwnerId") ?? c.get("userId")`, US-268) — the personal layer
inherits that and needs its own `tenant-isolation_test.ts` cases.

### US-1863: the floor, and what it costs to keep

The aggregation layer is `radar_venue_aggregates` (00549) — venue × window ×
brand, recomputed hourly by `/api/jobs/radar-aggregate` — and it holds **only
rows that clear the k-anonymity floor**. Four layers, deliberately, because a
privacy guarantee held in one place is held by whoever last remembered it:

1. `servableAggregates()` sits between the computation and the upsert, and is
   the only path to the table.
2. `contributor_count` carries a **CHECK of >= 2**, so the table cannot hold a
   single-contributor aggregate even if something else writes to it. The
   configured `radar_privacy.k_anonymity_floor` (default 3) is a minimum an
   operator may RAISE; `clampKFloor` refuses to go below the CHECK.
3. The read endpoint re-applies the floor on every row it serves.
4. A below-floor group produces **no row at all** — never a suppressed marker,
   because "hidden here" is itself the disclosure that somebody scanned there.
   The same reason `GET /venues/:id` returns an identical 404 for a below-floor
   venue and an unknown id, and why a below-floor venue is omitted from the
   bounding-box list rather than returned with an empty payload.

Three consequences that are easy to get wrong later:

- **A venue total is computed from the events, never by summing brand rows.**
  One person scanning two brands would otherwise count as two contributors and
  clear a floor of 2. Each brand row clears the floor on its own, so a venue can
  be servable while its long-tail brands are not.
- **The sweep is half the guarantee.** Every run stamps `computed_at` and then
  deletes what it did not rewrite, so a venue that FALLS below the floor loses
  its row. Without it the endpoint keeps serving an aggregate that no longer
  clears the floor — the same disclosure, a week late.
- **`avg_grade` is band-resolution.** The event store holds a band, never a
  numeric grade (00547's minimization, not undone), so the average is derived
  from band midpoints and can only land between 5.0 and 9.0.

Retention is the other half of rule 4 over time. `retentionCutoff` snaps to the
start of a whole expired **month**, and only then are raw events archived into
`radar_scan_history` (month resolution, venue OR cell) and deleted — the exact
ids that were rolled up, never a `WHERE scanned_at < cutoff` delete that could
remove a row the rollup never saw. The month snap is what makes the archive
idempotent: a partial prune re-runs against fewer events and produces a smaller
total, which `mergeHistoryRow` refuses to accept over the larger one it already
stored. `clampRetentionDays` will not let retention fall inside the widest
window — an aggregate whose raw events are already gone is a number nothing can
recompute or correct.

The network layer is Pro+, gated at the endpoint on the same `compPulls` flag
the Prospect scan that feeds it uses (rule 7). The personal layer is a separate,
free surface and is not served here.

## Two traps specific to these tables

- `radar_scan_events` **and `radar_venues`** deliberately have **no `user_id`
  column**, which makes them invisible to `rls-guard_test.ts`'s discovery regex. A deny-all table nothing
  looks at passes by never being examined, and a later commit could drop its RLS
  with nothing going red — so register EACH in **both** `SERVICE_ROLE_ONLY` and
  `SERVICE_ONLY_FORCED`. Full rule: [[service-role-tables]].
- Retention pruning and the rollup are the only things that keep rule 4 true over
  time. An aggregate that is recomputable from retained raw events is a raw event
  store wearing a rollup's name.

## Related

- [[extension-telemetry-consent]] — the consent rules Radar inherits, one surface earlier
- [[garment-passport-privacy]] — the salted-hash de-identification pattern
- [[service-role-tables]] — why an owner-less table must be registered twice
- [[buyer-platform]] — an allowance is inert until a call site refuses
- [[grading-scale-and-weights]] — the estimated grade a Radar event carries
- [[ralph-learnings]] — the working log that points here
- [[INDEX]]
