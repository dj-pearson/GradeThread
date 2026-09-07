# Resale Supply Index: design (stage 1)

**Date:** 2026-09-06
**Status:** approved in chat, not yet planned
**Backlog:** stories not yet filed. Product/edge stories go in `prd.json` (next
id `US-3132`); the public-page and sitemap stories go in `prd-seo.json` (next id
`US-9037`). Stage 1 is edge-only and files no SEO story.

## The question this answers

Reseller forums run a recurring thread: *"sales are down on eBay / Poshmark /
Mercari, is it just me?"* Nobody can answer it. Every reply is an anecdote.

GradeThread can answer half of it truthfully, and no competitor publishes the
answer.

## Why only half, and which half

**eBay's sold-price API is not granted to this account.** `ebay-client.ts:5169`
gates Marketplace Insights behind `EBAY_MARKETPLACE_INSIGHTS`, which is off.
`value-disclosure.ts:16` records the same fact from the other side: while that
scope is ungranted, every price behind "SOLD" is unavailable to us.

So **demand is unmeasurable here.** We cannot count what sold, or for how much,
on eBay.

**Supply is measurable, free, and already wired.** `searchBrowseComps`
(`ebay-client.ts:4856`) reads `payload.total` off Browse
`item_summary/search` and passes it to `toBrowseCompsResult`. That integer is
the number of live listings matching a query. It needs no extra scope, no
approval, and no new client code.

This is not a consolation prize. When a seller's sales fall, the cause is more
often that competing supply rose than that buyers left. Supply is both the
answer they need and the one we can prove. Stating it plainly, that we measure
listings rather than sales and why, is also the honest posture the rest of the
public data surface already takes.

## Why the existing report cannot carry this

`/resale-condition-report` is live and the pipeline works. Read 2026-09-06:

- Sample: 177 fulfilled sales, 923 listings, 180 priced sales, Jan 18 to Sep 6 2026.
- The **ungraded** band publishes real figures: 1.7% return rate, 20%
  sell-through, 27 median days to sell, $35 median resale value.
- All three **graded** bands say "not enough data yet", because only 26 garments
  are graded and `RESALE_MIN_SAMPLE` is 25.

The gate is working correctly. The problem is the cut. That report is keyed on
GradeThread's own condition grade, and grading volume will not fill it this
year. A supply index is keyed on brand and category, is fed by eBay rather than
by our users, and does not compete for the same scarce rows.

## Why stage 1 ships nothing visible

The product is a **trend**: listings up 41% in 30 days. We hold zero days of
history. A page launched today can only say "there are 4,102 Nike hoodies
listed", which answers nothing and cannot be improved by writing it better.

Stage 1 therefore starts the clock and nothing else. It is a table, a cron, and
a retention rule. The public surfaces are stage 2, specced separately once the
panel has 30 days in it.

## What already exists, and must be reused

| Concern | Reuse | Do not |
|---|---|---|
| Browse total count | `searchBrowseComps` and its `payload.total` | write a second Browse caller |
| Privacy-safe market rows | `comp_condition_reads` (`00663`) shape and comment style | store listing ids, URLs, titles or seller data |
| Cron plumbing | `requireJobSecret` + `acquireJobLock` + `CRON_REGISTRY` | hand-edit `CRON_SETUP.md` between the generated markers |
| Retention | `EBAY_RETENTION_RULES` in `ebay-retention.ts` | keep eBay-derived rows forever by default |
| Rate headroom | `ebay_rate_limit_snapshots`, written by the existing limits cron | hardcode a guessed daily Browse ceiling |
| Sample honesty | the `RESALE_MIN_SAMPLE` and "not enough data yet" pattern | print a trend off two observations |

## The data model

One new table. One row per cell per day.

```
public.marketplace_supply_samples
  id                 uuid pk
  cell_key           text not null    -- brand + category + marketplace, normalized
  marketplace        text not null    -- 'ebay' at stage 1
  brand_key          text             -- null for a category-only cell
  category_id        text not null    -- eBay leaf category
  observed_on        date not null    -- UTC date of the sample
  active_listings    bigint not null  -- Browse payload.total
  median_ask_cents   bigint           -- median of the sampled page, null below MIN_PRICE_SAMPLE
  ask_sample_size    int not null default 0
  currency           text not null default 'USD'
  created_at         timestamptz not null default now()
  unique (cell_key, observed_on)
```

`cell_key` reuses the existing normalization so a supply row and a
`comp_condition_reads` row describe the same cell. It is the join that makes
stage 2 able to say "supply up, asking prices down" in one sentence.

**What never reaches this table:** no seller, no listing id, no URL, no title,
no image. Same standing constraint as `comp_condition_reads` (US-2841), and for
the same reason: a row here is a point in a distribution, never a statement
about one person's listing.

`unique (cell_key, observed_on)` is load-bearing. A cron that runs twice, or a
retry after a partial failure, must not double-count a day into the trend.

**RLS:** enable, zero policies, `revoke all from anon, authenticated`, copying
`00663` exactly. This is a table revoke, not a function revoke, so the
no-REVOKE-on-function rule (`00609`) does not apply and is not triggered.

**Migration triple (US-1108):** idempotent SQL, `EXPECTED_SCHEMA_VERSION` bumped
in the same commit, self-record footer. Next number is `00743`.

## The cell list

About 200 cells, seeded as data rather than discovered. Two kinds:

1. **Brand plus category** for the brands the KB already carries with real
   colorway and size coverage. These are the cells a FlipDesk user actually
   sources into.
2. **Category only** for the top clothing leaves. These are the cells that make
   the stage 2 index legible to somebody who does not sell that brand.

Seeded in the same migration, as rows, so the list is reviewable in a diff and
changeable without a deploy.

**Size the crawl against real headroom.** Do not assume a Browse quota. The
limits cron already snapshots eBay's own reported ceiling into
`ebay_rate_limit_snapshots`; the new cron reads the most recent Browse row and
refuses to start a pass that would exceed a configured fraction of the
remaining budget. If no snapshot exists it runs a conservative fixed batch and
says so in its response. A crawl that quietly eats the Browse budget would
degrade comps on the seller Add flow, which is a hot path and matters more than
this index.

## The cron

`POST /api/jobs/supply-sample`, daily, registered in `CRON_REGISTRY` and
rendered into `CRON_SETUP.md` by `scripts/render-cron-setup.ts`, never by hand
(`cron-registry-drift_test.ts` guards it).

Shape follows `jobs-ebay-search-terms.ts`:

1. `requireJobSecret`, else 401.
2. `acquireJobLock("supply-sample", 1800)`, skip cleanly if held.
3. Read Browse headroom; compute how many cells this pass may touch.
4. For each cell: one `searchBrowseComps` call, take `total` and the page's
   asking prices, upsert one row on `(cell_key, observed_on)`.
5. Return `{ok:true, cells, sampled, skipped, no_headroom}`.

**Most ticks are unremarkable and must stay quiet.** A cell returning the same
count as yesterday is the normal case and is counted, not logged.

**A failed cell is skipped, not fatal.** One eBay 500 on one cell must not lose
the other 199 samples for the day. Count failures, return them, keep going.

## Retention

Add one rule to `EBAY_RETENTION_RULES`:

- Table `marketplace_supply_samples`, age column `observed_on`, **730 days**,
  action `delete`.
- A rationale line, in plain words, for the privacy page.

Two years keeps a year-over-year comparison, which is the most useful thing a
seasonality question can ask, and discards the rest. `ebay-retention_test.ts`
fails the build if the rule is not described on `src/pages/legal/privacy.tsx`,
so the privacy copy ships in the same commit.

The measure differs from the other rules deliberately. Elsewhere the rule is
`last_seen_at`, because a re-confirmed observation is current data that happens
to have an old row. Here every row is a dated measurement whose whole value is
its date, so ageing on `observed_on` is correct and ageing on anything else
would be wrong.

## Testing

Pure functions first, no DB and no eBay:

- Cell-list expansion: N brands by M categories produces the expected cell keys,
  and a duplicate in the seed collapses rather than creating two rows.
- Headroom math: given a snapshot with X remaining, the pass size is the
  expected fraction; given no snapshot, the conservative batch.
- Median asking price returns null below `MIN_PRICE_SAMPLE` rather than a
  median of two.
- Upsert idempotence: the same cell sampled twice on one date leaves one row.

Route level, against the throwaway local stack (`docker start
supabase_rest_gradethread supabase_kong_gradethread`, per `CLAUDE.md`):

- No job secret returns 401.
- A held lock returns `{ok:true, skipped:true}`.
- One failing cell does not abort the pass.

**Tenant isolation:** this table is service-role-only and has no `user_id`, so
it is an operator table. Register it with the rls-guard the way the other
service-role tables are, per the `tenant-isolation` skill. It needs no
`tenant-isolation_test.ts` case because no route reads it on behalf of a user at
stage 1.

## What stage 2 will need from this, and is therefore out of scope now

Named so the stage 1 shape does not foreclose them, not to be built:

- `/tools/market-check`. A seller picks brand and category, gets the 30 and 90
  day supply change plus our own sell-through where the sample clears the gate.
- `/resale-supply-index`. The monthly roll-up table, one page, cited by URL.
- Both are public pages and need `PUBLIC_ROUTES` plus `entry-server.tsx`
  registration, so both are `prd-seo.json` stories.

## Open questions

None blocking. Two to settle when stage 2 is specced:

1. Whether the public surface names brands, or only categories. Naming brands is
   far more useful and slightly more likely to attract a brand's attention.
2. Whether Poshmark and Mercari supply can be sampled at all without a scraping
   posture this project has not taken. eBay alone is a real product; the
   multi-platform version is a different risk conversation.

## The claim this may make, and the one it may not

**May:** "Live eBay listings matching this brand and category rose 41% in the
last 30 days." That is measured, dated, and reproducible.

**May not:** "Sales are down 41%." We do not have sold data and must never imply
that we do. Every surface built on this table states the measure in the same
breath as the number.
