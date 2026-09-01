# Fit & Measurement Index: design

**Date:** 2026-08-31
**Status:** approved in chat, not yet planned
**Backlog:** stories not yet filed. Product stories go in `prd.json` (next id
`US-3033`); the public-page and sitemap stories go in `prd-seo.json` (next id
`US-9037`).

## Why this exists

Every clothing brand publishes a **body** size chart: the wearer's chest, the
wearer's waist. Almost nobody publishes **flat-lay garment** measurements: pit
to pit, hem to hem, laid on a table. Those are the numbers a resale listing is
actually written with, and the numbers a buyer asks for before they buy.

That gap is confirmed inside this repo rather than assumed. Migration `00674`
added `brand_size_charts.measurement_basis` precisely because every one of the
292 seeded charts is body-basis, and its comment says so outright: the athleisure
block from `00452` states "All BODY measurements, never flat-garment."

So there is a real question with real search volume and no good answer anywhere,
and GradeThread is one of the few operations that can answer it, because its
users measure real garments every day.

### Why this over the other candidates

Three candidates were weighed in chat on 2026-08-31:

| Candidate | Traffic | Moat | Verdict |
|---|---|---|---|
| Fit & Measurement Index | yes | yes | **chosen** |
| Repair ROI | weak | strong | later |
| Condition-adjusted pricing | none | strong | later, see `US-2280` |

The measurement index is the only one that is both a search asset and a product
differentiator, and its dataset builds itself out of work users already do.

### Why this shape, given the traffic diagnosis

`vault/40-growth/seo-strategy-options-2026-08.md` recorded the finding that
governs every content decision on this site: **the site ranks and does not get
clicked.** 149 URLs sit at position 3-10 and convert at 0.85%. Definition pages
are a zero-click class because Google answers them in the SERP. Tool pages beat
them 10x, with `/tools/authenticity-check` at 9.0% CTR.

A measurement table is not a definition. Google cannot summarise "the median
waist of a Levi's 550 in W34 across 14 measured pairs" out of the SERP, because
nobody else holds that number. That is the whole bet.

## What already exists, and must be reused

Nothing here is greenfield.

| Piece | Where | What it gives us |
|---|---|---|
| `measure-extract.ts` | edge lib | calibrated real-inch measurements from a MeasureCard photo, per-field confidence, `flagged` outliers |
| `MEASUREMENT_TEMPLATES` | `measurement-templates.ts` (edge + `src/`) | the 10 garment groups and their field keys, and which fields are `required` |
| `brand_styles` | migration `00389` | `brand_key` + `style_name` + aliases + department: model-level identity, already resolved by the composer |
| `brand_size_charts` | `00389`, basis added in `00674` | the body-chart corpus and the deny-all-RLS-plus-service-role read pattern |
| `size-systems.ts` | edge lib | `detectSizeSystem`, `detectSizeClass`, `normalizeDepartment`, `systemFromLabel`, `usEquivalentForLabel` |
| `flipdesk-size-bands.ts` | edge route | the exact precedent for a reference-only route: takes no item id, **rejects** an `itemId` param rather than ignoring it |
| `jobs-durability-aggregate.ts` + `durability-aggregate.ts` | edge route + lib | the nightly aggregate job shape: job secret, `acquireJobLock`, idempotent upsert, sample floor recorded rather than filtered at write time |
| `condition-index.ts` | edge lib | `MIN_INDEX_TOTAL_SAMPLE = 8`, and the philosophy that a thin cohort never ships a public claim |
| `functions/style/[code].ts` + `_shared/style-code-render.ts` | Pages Functions | edge-SSR page shape with provenance and indexable-only-when-resolved |
| `00658_measurement_drift` | migration | the drift plumbing the seller-facing warning hangs on |
| `flipdesk-measure.ts` | edge route | where measurements are written onto `inventory_items` |
| `flipdesk-import.ts` | edge route | already carries `description` on imported listing rows |

## Where the data comes from

Decided in chat: **the user's own garments, from two sources.** Public eBay
harvesting was rejected because eBay's API license restricts storing and
redisplaying listing data, and converting the body charts with ease math was
rejected because a derived estimate published as a measurement is the exact
dishonesty this codebase refuses elsewhere.

### Source 1: MeasureCard extractions

`measure-extract.ts` already returns inches on the card plane via the `US-1572`
calibration homography, with a per-field model confidence and a `flagged` bit for
values outside the size prior. These are the highest-quality observations
available anywhere, including from the brands.

Ingest at the point measurements are persisted in `flipdesk-measure.ts`. Rows
carry `source = 'measurecard'` and the extraction's own confidence.

### Source 2: listing text

FlipDesk already syncs and imports descriptions for its users' own connected eBay
listings. Resellers routinely write `Pit to pit: 22"` into them. A new pure
library reads those out.

The parser is deliberately conservative, because a bad parser silently poisons
every page it touches:

- **A label and a unit are both required.** `chest 22in`, `pit to pit: 22"`,
  `Inseam - 32 inches` are accepted. A bare `22` is not, and neither is a number
  in a sentence about anything else.
- **Per-field sanity bands.** Each `field_key` gets a plausible inch range (for
  example chest 12-40, inseam 20-40). Anything outside is dropped, not clamped.
- **Centimetres are converted, not guessed.** Only when the unit is written.
- Rows carry `source = 'listing_text'` and a fixed lower confidence.

Both sources write to the same table with their source recorded, so a parser
defect is undone by deleting one source rather than rebuilding the corpus.

## Data model

Two new tables in one migration.

### `garment_measurements` (observations)

One row per garment, per measured field.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid not null | the contributing tenant; RLS scope and the opt-out delete key |
| `item_id` | uuid not null | so one garment counts once per field |
| `brand_key` | text not null | matches `brand_styles.brand_key` |
| `style_key` | text not null default `''` | normalized `brand_styles.style_name`; empty when no style resolves |
| `department` | text not null default `''` | `normalizeDepartment` output |
| `measurement_group` | text not null | a `MeasurementGroup` value |
| `size_label` | text not null | normalized, see below |
| `size_system` | text | `detectSizeSystem` / `systemFromLabel` output |
| `field_key` | text not null | a `MeasurementField.key` |
| `inches` | numeric(5,2) not null | |
| `source` | text not null | `measurecard` \| `listing_text` |
| `confidence` | numeric(3,2) | |
| `created_at` / `updated_at` | timestamptz | |

Unique on `(item_id, field_key)`, so re-measuring an item updates its row rather
than double-counting it.

`style_key` and `department` are `NOT NULL DEFAULT ''` rather than nullable, for
the reason `brand_styles` gives in `00389`: PostgREST upsert `onConflict` cannot
target an expression index, so the natural key has to be plain columns.

RLS: tenant-scoped, users read and write only their own rows. It is their
inventory data.

### `garment_measurement_stats` (the published aggregate)

Rebuilt nightly. Never written by a user.

| Column | Type | Notes |
|---|---|---|
| `brand_key`, `style_key`, `department`, `measurement_group`, `size_label`, `field_key` | text | the natural key, unique together |
| `sample_count` | int not null | garments behind the number |
| `contributor_count` | int not null | distinct `user_id` behind the number |
| `p25`, `median`, `p75` | numeric(5,2) | |
| `sufficient` | boolean not null | both floors cleared |
| `updated_at` | timestamptz | |

RLS: **deny-all**, read through the service-role client only. Same pattern and
same reasoning as `brand_size_charts` (see the `US-268` note at the top of
`flipdesk-size-bands.ts`): it is global reference data with no tenant to scope by.

Following the `jobs-durability-aggregate.ts` precedent, insufficient cohorts are
**still written** with `sufficient = false`, so the read path filters rather than
the write path hiding. That keeps the coverage measurable, which is what tells us
when a page is close to qualifying.

### Size normalization

`size-systems.ts` gains `normalizeSizeLabel(raw, group)`. It is the join key, so
`W34 L32`, `34x32` and `34X32` must produce one label or the corpus splits into
useless fragments.

Rules, in order:
- Trim, collapse whitespace, uppercase.
- Waist-by-inseam forms collapse to `34X32`.
- Alpha sizes collapse to the canonical token (`MEDIUM`, `MED`, `M` all become `M`).
- Numeric sizes keep their number and drop decorations.
- Anything unrecognised is stored verbatim and never merged with anything else.

## The publishing floor

Two gates. Both must pass for a field to be public.

```
MIN_MEASUREMENT_SAMPLE      = 5   // garments
MIN_MEASUREMENT_CONTRIBUTORS = 3  // distinct sellers
```

The second gate is the privacy gate. A number backed by one seller's closet is a
statement about that seller's inventory. A number backed by three is a fact about
the garment.

A page publishes only when **every `required` field for its `measurement_group`**
clears both gates. A `bottom` page needs `waist` and `inseam`; `rise`, `hip` and
`leg_opening` appear when they qualify and are absent when they do not. A page
never shows a blank row or a placeholder.

The sample count is printed on the page: "Median of 14 measured pairs." That
sentence is the entire competitive claim. No brand chart can write it, no
crosslisting tool can write it, and it is what makes the number worth citing.

Why 5 and 3 rather than the condition index's 8. Price variance across a cohort
is large, so a price claim needs more samples to be honest. Flat measurements of
one style in one size vary by a fraction of an inch, so five real garments
already produce a stable median. Three contributors is the k-anonymity floor,
chosen independently of the sample floor because it is protecting a different
thing. Both are decisions, written down so the next person argues with the
reasoning instead of the number.

## The nightly job

`POST /api/jobs/measurement-aggregate`, modelled directly on
`jobs-durability-aggregate.ts`:

- `requireJobSecret(c)` gate.
- `acquireJobLock("measurement-aggregate", 600)`.
- Pure computation in a new `lib/measurement-aggregate.ts`.
- Idempotent upsert on the natural key.
- Returns `{ cohorts, sufficient, upserted }`.

Outlier handling lives in the pure lib: within a cohort, values past 1.5 IQR are
dropped before the median and quartiles are computed. With small cohorts this
matters, and it is the reason a single fat-fingered `220` cannot move a page.

Registered as a Coolify scheduled task. `US-2313` already records that nothing in
version control creates the production cron schedules, so this job's schedule is
an operator step and the story must say so rather than assume it.

## What the seller gets

This half ships before any public page and pays for itself on its own.

### Autofill

In the composer, when an item has a resolved brand, style and size, and its
measurements are empty, and the aggregate has a `sufficient` cohort:

- Values render as **suggestions, not saved values.** Ghosted in the fields.
- One line beneath: "Median of 14 measured pairs."
- One button: "Use these." The seller can also type over any of them.
- Nothing is written until the seller acts.

A silent write is not acceptable here. A wrong measurement on a listing becomes a
return, and returns are the problem this product exists to prevent.

### Drift warning

`00658_measurement_drift` already exists. When a seller's entered measurement
sits far outside the cohort (past p25/p75 by more than a field-specific margin),
flag it inline: "Most 550 W34s measure 17 inches at the waist. Yours says 19."

That is a mismeasure or a mislabeled item, and catching it before publish is
worth more to a working reseller than the autofill is.

### Reads

One new reference-only edge route, `GET /api/flipdesk/measurement-stats`, taking
brand, style, department, group and size. It follows `flipdesk-size-bands.ts`
exactly: no item id, no tenant table, and an `itemId` param is **rejected** rather
than ignored, so a future caller cannot quietly turn a reference lookup into a
tenant read.

## The public pages

Three tiers. Not four.

| Path | What it is |
|---|---|
| `/measurements` | hub: what a flat measurement is, how to read the table, total garments behind the index |
| `/measurements/:brand` | every published style for that brand, linked |
| `/measurements/:brand/:style` | **the money page**: the full size run in one table |

Per-size pages are deliberately excluded. `vault/40-growth/seo-indexability.md`
records that ~79% of the static surface is already templated and that a large
templated footprint on this domain invites suppression. A style page holding the
whole size run is one strong page instead of twelve thin ones, and it matches how
the query is actually typed: `levis 550 measurements`, not `levis 550 w34
measurements`.

### Rendering

Edge-SSR as Cloudflare Pages Functions, following `functions/style/[code].ts`:

- `functions/measurements/[[path]].ts` plus a shared renderer in
  `functions/_shared/measurement-render.ts`.
- A pure shaping lib computes `indexable` **once**, so the page and the sitemap
  cannot disagree. This is the `public-style-code.ts` rule and it is not optional.
- A page with no `sufficient` cohort renders as a real 404, never a soft 404 with
  an empty table.

The content grows nightly. Static prerender would need a deploy per change, so it
is the wrong tool here.

### SEO wiring

- **Own sitemap segment,** `sitemap-measurements.xml`, listed alongside the other
  commercial segments. A segment makes the cluster's indexation readable as one
  line in Search Console, which is the only way its kill criteria are answerable.
  This is the reasoning `US-9015` used for `sitemap-care.xml`.
- **Interlinking: the `reselling` hub.** No new `Hub` value in
  `interlink-rules.ts`. The audience is the same seller and links should flow both
  ways, which is the opposite of the one-way containment `care` needs.
- **JSON-LD: `Dataset`** with `variableMeasured` per field, plus `BreadcrumbList`.
  This is the correct type for a table of measured values, and it is what an
  answer engine reads when deciding whether a number is citable. Mirror it in
  `head-builder.ts` `jsonLdForRoute()` per the standing rule, and register the
  three route shapes in `src/lib/seo/public-routes.ts` and
  `src/prerender/entry-server.tsx` or the CI guards fail.
- **Copy leads seller-first.** The page answers "what measurements do I put in
  this listing", the CTA is FlipDesk autofill, and a buyer-facing fit line sits
  below it linking to the existing `/tools/fit-checker`. This follows the
  2026-08-18 finding that 99% of Path 3's volume carries seller intent and that
  buyer traffic has no monetization path attached yet.

## Disclosure and opt-out

Contribution is **opt-out**, and that only holds if it is disclosed properly.
The existing privacy policy does **not** cover this today. Its aggregate clause
(`src/pages/legal/privacy.tsx`, the "de-identified images and aggregated grading
outputs" bullet) permits internal use for model accuracy, benchmarks and prompts.
It says nothing about publishing an aggregate on a public page. That gap closes
**before the first observation row is written**, not after.

`US-2643` is the standing example of why: a retention row promised a purge that
did not happen, and the fix was to make the words true rather than to soften them.

Six pieces:

1. **Privacy policy.** A new clause naming what is aggregated (garment
   measurements only, never photos, never seller identity), the floor of five
   garments from three sellers, that the result appears on public pages, and the
   switch.
2. **Terms, Section 4 ("Your content and licenses", the grant at line 107).**
   Extend the grant to cover publishing derived aggregate measurements. Narrow
   wording: measurements only, aggregate only.
3. **Retention table row.** What happens to contributions on opt-out and on
   account deletion.
4. **In-product disclosure.** One line in the composer where the autofill
   appears, with the setting one click away. Not buried.
5. **Settings toggle.** Off means new measurements stop being contributed **and**
   existing `garment_measurements` rows for that user are deleted. The next
   nightly rebuild drops them from the published numbers. Stated plainly,
   including that already-published pages are recomputed rather than frozen.
6. **Changelog.** Date the policy change on `/changelog`.

No new subprocessor is involved, so `subprocessors.tsx` is untouched.

### The settings-column landmine

`00526` made `public.users` self-updates deny-by-default via a write allowlist.
A new preference column **must restate the allowlist in the same migration**, or
the toggle renders, saves without error, and changes nothing. This has bitten
this project before. See the `users-column-frozen-by-default` memory.

Also relevant: `00609`'s no-revoke block must be copied rather than writing a
fresh `REVOKE`, because a denied `anon`/`authenticated` call segfaults production
Postgres (`US-2403`, still open).

## Testing

- **The text parser** gets a fixture of real listing description shapes,
  including the ugly ones: multiple measurements in one line, ranges, cm, tables
  rendered as text, and prose that contains numbers meaning nothing. This is the
  component most likely to be quietly wrong, and a silent parser defect is
  indistinguishable from real data once it lands.
- **`normalizeSizeLabel`** gets a table test proving the collapse rules and
  proving that an unrecognised label never merges with anything.
- **The floor** gets a test that fails if any page or API response can render a
  cohort below 5 samples or 3 contributors.
- **The aggregate math** gets unit tests for the IQR drop, the quartiles and the
  idempotent upsert.
- **The opt-out** gets a test proving the rows leave the aggregate on the next
  rebuild, not merely that new ones stop arriving.
- **Tenant isolation:** a case in `tenant-isolation_test.ts` for each new edge
  route, per the standing rule. `garment_measurement_stats` is deny-all
  service-role, so it also needs an `rls-guard` registration.
- **The `itemId` rejection** on the reference route is asserted, not assumed.

## Migrations

Two migrations, both following the `US-1108` triple (idempotent SQL,
`EXPECTED_SCHEMA_VERSION` bumped in the same commit, self-record footer):

1. `garment_measurements` + `garment_measurement_stats`, their RLS, and the
   `rls-guard` registration.
2. The `users` preference column **with the `00526` allowlist restated**.

Per the standing rule, a commit carrying a migration waits for the owner's
explicit OK before it moves anywhere.

## Build order

The product half ships first and stands alone. No public page exists until the
data justifies one.

1. Migrations, the two tables, `normalizeSizeLabel`.
2. Ingestion from MeasureCard.
3. The listing-text parser and its backfill over already-synced descriptions.
4. The nightly aggregate job, and the operator step to schedule it.
5. Disclosure: privacy, terms, retention row, settings toggle, changelog.
6. Composer autofill and the drift warning.
7. The public hub, brand and style pages, the sitemap segment, the JSON-LD.

Steps 1-4 produce no user-visible change and no public claim. Step 5 gates step 6.
Step 7 ships whatever has cleared the floor by then, and grows on its own after.

## What would kill this

Named now, so it is checked rather than hoped for.

- **Coverage never reaches the floor.** If after the backfill fewer than a few
  dozen brand-style-size cohorts clear 5 samples and 3 contributors, there is no
  public surface worth building and step 7 should not ship. Measure this at the
  end of step 4, before writing a single page.
- **Identity resolution is too thin.** `US-2216` already records that
  `brand_styles` covers a fraction of the knowledge base's brands. Observations
  with no resolved style fall back to brand-level cohorts, which are weaker pages.
  If the resolved share is low, `US-2216` becomes a prerequisite rather than a
  neighbour.
- **The parser is wrong in a way nobody notices.** Mitigated by the source column
  and the fixture suite, and by holding `listing_text` at a lower confidence than
  `measurecard`.

## Related

- `vault/40-growth/seo-strategy-options-2026-08.md`: the zero-click finding and
  the tool-page evidence this is built on
- `vault/40-growth/seo-indexability.md`: the argument against another wide
  templated family, which is why there are three tiers and not four
- `vault/40-growth/seo-public-route-registry.md`: the lockstep registration rule
- `vault/20-domain/service-role-tables.md`: the `rls-guard` registration
- `US-2280`: outcome-grounded grading truth, the natural follow-on once
  measurement and grade data sit in the same aggregate
