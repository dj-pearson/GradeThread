# Style-code discovery: filling the index brand-first

Date: 2026-08-21
Status: approved, ready for implementation
Owner decision recorded: crawl **every brand we hold background knowledge on**, not
Lululemon alone. When that pool is exhausted, widening the brand pool itself becomes
the next piece of work, not a change to this design.

## The problem

The learned style-code index (US-2246, migration 00503) is **reactive**. Every path
that feeds it starts from a code we have already met:

- `ai-tag-ocr` reads a code off a tag a seller photographed.
- `jobs-style-code-sweep` (US-2690) takes codes already on items or already in the
  index, and asks eBay what the market calls them.

So the index can only ever describe garments that have already passed through the
building. The codes worth knowing are the ones nobody here has listed yet: the
garment a reseller is holding right now, the one the public `/style/:code` page
gets a visit for and cannot answer.

There is a second, quieter problem. `style_code_sweep_candidates` does not exist in
production (US-2729, migration 00627 half-applied), so the reactive sweep has
errored on every hourly run since it shipped. Discovery is worth nothing while that
is true, and it is a prerequisite rather than a nice-to-have.

## What discovery does

A new cron walks eBay brand-first and keeps what sellers have already typed into
structured fields.

1. Pick the brands least recently crawled, from `brand_knowledge`.
2. For each, run a Browse search scoped to clothing, filtered by the Brand aspect,
   paging deeper on every tick via a stored offset.
3. For a bounded slice of the results, fetch item specifics.
4. Keep only listings that **declare** a style code in a structured field
   (Style Code / MPN / Manufacturer Part Number / Style Number / Model Number).
5. Where the same listing also names a product in a structured field
   (Model / Product Line / Style), keep the name too.
6. Write the code as an observation and, when a name came with it, as a
   `style_code_names` row.

## The rule that does not move

**A title never creates a code and never creates a name.**

US-2751 recorded the reasoning and it holds here unchanged. A title is marketing
text assembled by a seller who may have bought the garment with nothing but a size
dot. A consensus over guesses is a confident guess. Worse, our own sellers publish
to eBay with titles our AI wrote, so reading titles back counts our own output as
independent corroboration.

An item specific is different in kind. A seller who filled eBay's Style Code box
typed a code off a tag on purpose. Discovery harvests that field and nothing else.

Three consequences that are load-bearing:

- `declaredStyleCode` and `declaredProductName` from `lib/style-code-aspects.ts` are
  reused verbatim. Discovery does not get its own softer copy of the rule.
- Our own eBay listing ids are excluded before anything is harvested, the same way
  the sweep does it.
- A discovered name enters at the `consensus` source and confidence band, which sits
  below a seller correction and below a decoder hit. Discovery can populate; it can
  never overrule.

## Components

### `lib/style-code-discovery.ts` (pure)

No eBay, no database, no clock. Every rule below is a unit test.

- `pickDiscoveryTargets({ brands, state, budget, now })` returns the brands this tick
  should spend its eBay budget on. Least recently crawled first; brands inside their
  cooldown are skipped; brands whose cursor passed eBay's paging ceiling wrap to zero
  and take a long cooldown. Returns what it deferred rather than truncating silently.
- `harvestListing({ listing, canonicalize, ownItemIds })` turns one listing's aspects
  into a `DiscoveryFind` (code, optional name, item id, url) or null.
- `planDiscoveryWrites(finds)` collapses a page into one write per code, so ten
  identical listings of one garment are one piece of evidence.
- `summarizeDiscovery(outcomes)` produces the counters the tick reports.

### `lib/ebay-client.ts`: `searchBrowseByBrand`

`searchBrowseComps` cannot page. Discovery needs `offset`, so it gets its own
function rather than a fifth optional argument on the comps path, which is on the
seller's hot path and should not grow a parameter it never uses.

Scoped to `category_ids=11450` (Clothing, Shoes & Accessories) because eBay requires
a category scope before it will accept an `aspect_filter`, and the Brand aspect is
what makes the results a brand crawl rather than a keyword search.

eBay caps `limit + offset` at 10,000. The module treats 9,950 as the ceiling.

### `supabase/migrations/00646_style_code_discovery.sql`

- `style_code_discovery_state`: one row per brand holding the cursor, when it last
  ran, how many listings and codes the last pass saw, and how many consecutive
  passes found nothing new. Global reference data, no owner column, deny-all RLS,
  registered in `SERVICE_ROLE_ONLY`.
- `record_style_code_discovery(...)`: upsert the state row. A function rather than a
  table write so the counters accumulate server-side and two ticks cannot clobber
  each other's totals.
- `style_code_discovery_brands(p_limit)`: the brand rotation, joined to state, newest
  cursor last. A function for the same reason `style_code_sweep_candidates` is one:
  a row scan capped in the client starves whichever brands sort late.
- Widen the `style_code_observations` source check to admit `'discovery'`.

Without the cursor table a tick re-reads page one forever, which is the specific way
this kind of job looks healthy and learns nothing.

### `routes/jobs-style-code-discovery.ts`

Job secret, then a job lock named `style-code-discovery`. A second tick arriving
while the first runs does nothing at all — not a smaller crawl, not a retry. Both
would spend the shared eBay budget on the same offsets.

Sequential, like the sweep, and for the same reason: these calls come out of the
app-level eBay allowance that comps and the seller Add flow also draw on. A fan-out
here is how one tick starves somebody mid-listing.

### Schedule

`10 3 * * *` — once a night. Registered in `lib/cron-runs.ts` with its healthy
signature, and `CRON_SETUP.md` regenerated from the registry.

Overnight because the budget is shared. Nightly rather than hourly because a brand's
listings do not turn over fast enough for a second pass the same day to find
anything a first pass missed.

## Budget

Per tick: `brands x (1 search + N item lookups)`.

Defaults: 3 brands, 20 item lookups each, so 63 eBay calls a night. Both are env
overridable (`STYLE_CODE_DISCOVERY_BRANDS`, `STYLE_CODE_DISCOVERY_LOOKUPS`) so the
rate can be raised once the real hit rate is known without a deploy.

The number to watch after the first week is codes-found per item-lookup. If most
clothing sellers leave the Style Code field empty the lookups are the wrong place to
spend, and the answer is fewer brands crawled deeper rather than more calls.

## Reporting

The tick logs and returns: brands considered, brands crawled, brands deferred,
listings scanned, listings with a declared code, new codes, codes already known,
names written, own listings skipped.

Deferred is reported explicitly. A job that reports only what it did reads as "we
covered everything" on a run that covered a fraction.

## Testing

- `src/tests/style-code-discovery_test.ts`: the pure module. Rotation order,
  cooldown, cursor wrap at the ceiling, deferral accounting, harvest accepting a
  declared code, harvest refusing a title that contains a code, harvest refusing a
  one-word Model value, own-listing exclusion, per-page collapse.
- `src/tests/tenant-isolation_test.ts`: a case asserting the discovery route reads
  and writes no tenant table. It reads `brand_knowledge` and its own state table and
  writes the non-tenant index. The one tenant table it touches is `listings`, read
  for `platform_listing_id` only, which is the same read the sweep already makes and
  exists precisely to exclude our own data rather than to use it.
- The route's lock behaviour, via the injected acquirer seam the sweep established.

## What this is not

- Not a scraper. Every call is the eBay Browse API under our existing app
  credentials. Scraping listing HTML would breach eBay's terms and put the
  marketplace connection at risk for a worse version of the same data.
- Not a price or seller record. Only brand, code, product name, listing title and
  listing URL are kept, matching the 00503 rule. No seller id, no buyer, no price.
- Not a queue. Like the sweep, the work-list is derived every tick. A tick that dies
  loses nothing but its cursor advance.

## Sequencing

1. US-2729 — fix the half-applied 00627 in production. Blocks everything.
2. The eBay client paging function and the pure discovery module.
3. The migration.
4. The route, wiring, and cron registration.
5. Admin visibility: discovery counters on the existing brand-knowledge admin page.
6. Then the widening work: brands we hold no knowledge on yet.
