---
title: Ralph Thrift Radar working log
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-09
tags: [agent, ralph, radar]
summary: Traps from Thrift Radar (US-1860…US-1867), most of them consequences of its location-privacy promise.
---

> [!info] Read ON DEMAND, not every iteration.
> Split out of [[ralph-learnings]] by US-2445, which had grown to 892 lines
> against its own 800-line rule. Nothing here was deleted or reworded — it is
> the same text, one hop away instead of on every loop iteration.
>
> Read this for Thrift Radar. The RULES live in [[thrift-radar]]. Nearly every
> bullet here is a consequence of one promise: no precise coordinate is stored.

# Thrift Radar (US-1860…US-1867)

- The Prospect scan endpoint carries NO location today, so Radar's first commit
  is the one that adds a coordinate to a request that never had one — the toggle,
  the consent copy and the "coordinates are discarded after venue resolution"
  promise all have to land in that same change; there is no later point to
  retrofit them quietly. Contributing and VIEWING are separate consents, the
  k-floor is enforced server-side (empty response, not a redacted one), and the
  personal layer is free and works at n=1. Rules: [[thrift-radar]].
- US-1861 landed that first commit. Two transferable bits: (1) a privacy promise
  is only as strong as the schema under it — state it as an absence the code
  cannot restore (`radar_scan_events` has NO coordinate column, and the geohash
  length is capped by a CHECK, not only by the config clamp), and test it as the
  row's KEY SET (`assertEquals(Object.keys(row).sort(), [...])`), which fails when
  someone adds the column back, unlike `assert(!row.lat)` which passes forever.
  (2) Split the pure transforms (geohash, rotation, row builder) into a module
  that imports NOTHING touching `lib/supabase.ts`, so its test needs no env dance.
- The way to keep "no precise coordinate is stored" true while STILL storing a
  place is to make the privacy property a consequence of the FUNCTION SIGNATURE,
  not of discipline at the call site: US-1862's `candidateVenueDraft(cell)` takes
  a geohash cell and has no coordinate parameter, so a venue centroid can only
  ever be a cell centre — identical for everyone in the cell, therefore not a
  record of where anyone stood. Pair it with a `centroid_source` column
  (`cell`|`user`|`places`) so a later precise value has to declare itself, and
  the guarantee stays checkable instead of remembered. Rules: [[thrift-radar]].
- A table whose natural key is a GENERATED column (US-1863's
  `radar_scan_history.place_key`) cannot be written with supabase-js
  `.upsert(rows, { onConflict: "place_key,month_start" })` — the conflict target
  has to be in the payload and a generated column may not be. Read the existing
  rows for the keys you are about to write, then split into `.insert()` and
  per-id `.update()`. Safe under a job lock (single runner); do NOT reach for the
  generated column in an upsert and assume PostgREST will infer it.
- A new `TEST_USER_A_*` env id that GATES a `tenant-isolation_test.ts` case must
  ALSO be emitted by `services/edge-functions/scripts/seed-tenant-isolation-fixture.ts`
  or classified in that file's `KNOWN_UNSEEDED` — a structural guard case parses
  both files and fails otherwise, because a gated case that skips in CI reports
  green while proving nothing. A plain-insert row (US-1864's `sources`) belongs in
  the seed script, not in KNOWN_UNSEEDED. The guard also fails on a STALE
  classification, so don't add one "just in case".
- When a feature adds a SECOND write derived from an input an earlier consent
  already justified (US-1864's private visit log off US-1861's coordinate), put
  both writes in ONE function so the input is resolved once and its life stays in
  one place — then give the two halves DIFFERENT gates inside it. The trap is the
  side effects that look harmless: minting a shared `radar_venues` candidate off a
  NON-contributor's fix is still a contribution, even though the row is a cell
  centre and names nobody. Hence a read-only `matchScanVenue` beside the
  create-and-bump `resolveScanVenue`. Rules: [[thrift-radar]].
- The reflex answer to "put this on a map" is a map library, and on any surface
  with a location-privacy promise that reflex is the bug: tile URLs ARE the
  viewport, so Leaflet/MapLibre streams the user's neighbourhood to a third-party
  CDN on every drag — leaking, from the display layer, exactly what the schema
  below it was built to withhold. US-1865 drew an SVG from data already served
  (Web Mercator + a graticule + a scale bar, `src/lib/radar-map.ts`): zero
  dependencies, zero external requests, fully unit-testable. Reach for a tile map
  only where the coordinate was never sensitive.
- A per-venue/per-entity BREAKDOWN (US-1865's day-of-week histogram) belongs as a
  COLUMN on the row that already clears the privacy floor, not as its own table
  or a read-path query over the raw events. As a column it inherits the floor,
  the recompute and the sweep for free; as anything else it needs a second copy
  of each guard, and a copied privacy guard goes stale on one side. Corollary for
  time-bucketed ones: bucket by the PLACE's approximate solar time
  (`Math.round(lng/15)*60`), never UTC — UTC smears every American evening onto
  the next day, and a real timezone lookup means sending the coordinate somewhere
  to resolve it.
- A permission's DECLARATIONS are prose, so a second surface using the same
  sensor falsifies them in total silence — no test, no lint, no reviewer. US-1866
  added a "stores near me" button to a location whose usage string, privacy
  manifest, App Store labels and policy section all said "only if you turn on
  contributions", and none of them went red. Amend all four IN THE SAME COMMIT,
  and say whether the new use COLLECTS anything (that is what decides label row
  vs. prose). Keep the amendment small by never prompting on appear and by
  quantizing the fix into a bbox before it leaves the device — then the honest
  sentence is short. Rule: [[thrift-radar]].
- When a feature BLENDS two data sources and only one of them is denominated in
  money, the tempting move is to invent an exchange rate (scans → dollars). Don't:
  anchor every figure on the source that IS money — the user's own books — and let
  the other be a bounded MULTIPLIER on it. US-1867 prices an unvisited store at the
  reseller's own average profit per visit times what the network says about the
  place, so the number is one they can check; and when they have no money history
  at all, the whole plan reports `null` and ranks without dollars rather than
  printing a plausible figure. A placeholder number reads as a finding.

## Related

- [[thrift-radar]] — the rules these bullets are about
- [[ralph-learnings]] — the always-read playbook
- [[INDEX]]
