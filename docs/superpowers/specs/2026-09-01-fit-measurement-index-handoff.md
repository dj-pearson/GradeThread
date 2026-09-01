# Fit & Measurement Index: handoff

**Date:** 2026-09-01
**Design:** `docs/superpowers/specs/2026-08-31-fit-measurement-index-design.md`
**Backlog:** `prd.json` — US-3033 to US-3041
**State:** 6 of 9 done. One gate blocked on live data, two pages blocked behind it.

## What this is

Brands publish **body** size charts. Almost nobody publishes what a garment
measures **laid flat**, which is the number a resale listing is written with and
the number a buyer asks for. Migration `00674` confirms the gap from inside the
schema: all 292 seeded `brand_size_charts` rows are body-basis.

The index fills that in from measurements FlipDesk users already record, and
publishes only what enough independent sellers back.

## Status

| Story | State |
|---|---|
| US-3033 foundation: two tables, `normalizeSizeLabel` | done |
| US-3034 MeasureCard ingestion | done |
| US-3035 listing-text parser + backfill | done |
| US-3036 nightly aggregate + the two floors | done |
| **US-3037 [GATE] coverage report** | **BLOCKED — tool built, cannot answer** |
| US-3038 disclosure + opt-out | done |
| US-3039 composer autofill + drift | done |
| **US-3040 public pages** | **not started, blocked by the gate** |
| **US-3041 sitemap + JSON-LD + registry** | **not started, blocked by US-3040** |

Migrations `00709` and `00710` are applied to production. `00710` was applied
once with a bug and re-applied corrected; the owner confirmed the fix.

## The three things that have to happen next, in order

Everything below is blocked on the first one.

### 1. Redeploy the edge service (operator)

Production is still running the old build. Measured, not assumed:

```
POST functions.gradethread.com/api/jobs/measurement-aggregate   -> 404
POST functions.gradethread.com/api/jobs/passport-backfill       -> 401
```

401 means "route exists, show me the secret". 404 means the route is not there.
Pushing updated the frontend; the edge deploys separately through Coolify.

**Until this happens nothing writes a measurement, and the tables sit empty.**

### 2. Create two Coolify scheduled tasks (operator)

Both endpoints exist and nothing calls them. `US-2313` already records that
nothing in version control creates the 73 production cron schedules.

```bash
# nightly — rolls observations into publishable numbers
curl -fsS -X POST https://functions.gradethread.com/api/jobs/measurement-aggregate \
  -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"

# every 15 min until drained — reads measurements out of synced listing text
curl -fsS -X POST https://functions.gradethread.com/api/jobs/measurement-text-backfill \
  -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET"
```

The backfill reports `drained: true` when the queue is empty; it can be dropped
to daily after that. `?reset=1` re-reads everything after a parser fix,
`?purge=1` deletes the text-sourced rows when a fix means the old ones should
never have existed. Neither belongs on a schedule.

### 3. Run the gate — US-3037

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  deno run --allow-net --allow-env \
  services/edge-functions/scripts/measurement-coverage-report.ts
```

It needs a **service-role key by construction**. The anon key reaches prod but
`garment_measurements` is tenant-scoped and `garment_measurement_stats` is
deny-all, so an anon read returns `[]` whether the table is empty or full —
the one answer this script must never give. No prod service-role key exists in
this working copy (`.env` holds a placeholder).

It prints two halves:

- **ACTUAL** — cohorts clearing both floors today, by garment group, plus the
  share of observations that resolved to a style rather than the brand rollup.
- **POTENTIAL** — the forecast from `inventory_items` alone: how many cohorts
  *could* clear the floors if every eligible garment were measured.

**How to read it.** Actual near zero with potential healthy means keep going and
the gap is measurement. Both near zero means the floor is out of reach on
today's inventory and US-3040/US-3041 should not be built. The product half
(US-3039) stands on its own either way.

Verified working against a seeded local fixture: 12 Levi's in one size across 4
sellers reported reachable, 3 Nike tees from 1 seller correctly not.

## What is left to build

Only if the gate says ship.

**US-3040 — the public pages.** Three tiers, deliberately not four:
`/measurements`, `/measurements/:brand`, `/measurements/:brand/:style` with the
full size run in one table. Per-size pages are excluded because
`vault/40-growth/seo-indexability.md` records that ~79% of the static surface is
already templated. Edge-SSR as Cloudflare Pages Functions following
`functions/style/[code].ts`; a pure shaping lib must compute `indexable` ONCE so
the page and the sitemap cannot disagree. No sufficient cohort is a real 404,
never a soft one. Every page prints its sample count.

**US-3041 — the SEO wiring.** Own `sitemap-measurements.xml` segment (readable
as one line in Search Console, the US-9015 reasoning). The existing `reselling`
interlink hub, no new `Hub` value. `Dataset` JSON-LD with `variableMeasured`
plus breadcrumbs, mirrored in `head-builder.ts`. Registry lockstep in
`public-routes.ts` and `entry-server.tsx` or CI fails.

## How it works, in one pass

**Two tables (00709).** `garment_measurements` is one row per garment per field,
tenant-scoped, unique on `(item_id, field_key)` so re-measuring updates rather
than double-counts. `garment_measurement_stats` is the published aggregate,
deny-all with no owner column, in **both** rls-guard lists (without
`SERVICE_ONLY_FORCED` the guard would check nothing while staying green).

**A cohort is** `(brand, style, department, group, size, field)`. Two keys decide
whether any of it works:

- `brandKeyForRaw`, never `brandKey`. Measured: `brandKey("Levi")` is `levi`
  while every read asks for `levis`. That is US-2692 exactly.
- `normalizeSizeLabel`, which collapses `W34 L32` / `34x32` / `34X32` into one
  label but refuses to merge `UK 10` with `10` or `10P` with `10`.

**Two sources.** MeasureCard extractions (calibrated, high confidence) and a
paranoid parser over the seller's own synced listing text. Public eBay
harvesting was rejected on eBay's API licence — do not reintroduce it because
the parser would work on it.

**The floors.** 5 garments AND 3 distinct sellers. They are different kinds of
thing: the first is quality, the second is privacy, and five garments from one
seller does not publish however good the measuring was.

**Evidence only ratchets up.** A card measurement overwrites parsed text; text
never overwrites a card measurement. An unresolved style never overwrites a
resolved one.

## Traps worth knowing before touching this

- **Copy the users allowlist from the LATEST migration, not from 00526.**
  `grep -l guard_users_protected_columns supabase/migrations/*.sql | tail -1`.
  Copying 00526 dropped eight columns and re-added two that 00671 removed for
  security. `src/test/users-self-update-allowlist.test.ts` catches only the two
  it can see.
- **`src/lib/measurement-drift.ts` is US-2827 and is NOT this feature.** It
  pools every brand together. This feature is `src/lib/measurement-index.ts`.
  Exactly one warning renders per field: index first, old band as fallback.
- **Run things against a database.** Three real bugs were found that way and
  none by fixtures: the style downgrade, the retirement pass being skipped on
  an empty aggregate, and the allowlist regression.
- **`src/test/no-invisible-characters.test.ts` earns its keep.** It caught a
  literal no-break space inside the parser's own no-break-space regex.

## Verification status

Everything below was run, not assumed.

- Edge: `deno check src/main.ts` clean; measurement suites 55+ passing.
- Web: `tsc -b` clean, `eslint` clean, `ui:check` 0 blocking, 3705 tests passing
  at last full run.
- Migrations: both apply twice cleanly on a throwaway stack; policies read back
  from `pg_policies`, not from the migration file.
- Opt-out chain proven live: rows deleted at once, ingest then refuses, rebuild
  drops the cohort from 5/3/published to 3/2/unpublished.

**Never verified against real data:** every composer surface. Prod has no
observations yet, so the autofill banner and the drift note have never rendered
against a live cohort. That is what step 3 unblocks.
