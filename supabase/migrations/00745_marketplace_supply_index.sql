-- US-3132: the two tables behind the resale supply index.
--
-- eBay's sold-price API is ungranted on this account, so demand cannot be
-- measured and supply can: Browse returns a `total` on every search. These
-- tables record that count, per market cell, per day, so that in a month there
-- is a trend instead of a number.
--
-- Reasoning, and the claim this data may never make, are in
-- docs/superpowers/specs/2026-09-06-resale-supply-index-design.md and in
-- services/edge-functions/src/lib/supply-sampling.ts.
--
-- AGGREGATE MARKET DATA ONLY, the comp_condition_reads posture (00663): no
-- seller, no listing id, no URL, no title, no owner column anywhere. A row is a
-- point in a distribution, never a statement about somebody's listing.

-- ── the cells we measure ───────────────────────────────────────────────────
-- Rows rather than code so the list is reviewable in a diff, and so a cell is
-- retired by flipping is_active instead of by a deploy.
create table if not exists public.marketplace_supply_cells (
  cell_key      text primary key,
  marketplace   text not null default 'ebay',
  brand_key     text,
  brand_display text,
  category_id   text not null,
  query_terms   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on table public.marketplace_supply_cells is
  'US-3132: the market cells the supply index measures. cell_key is normalizeItemKey (brand|category|q) so a row joins comp_condition_reads and condition_price_curves.';

create index if not exists marketplace_supply_cells_active_idx
  on public.marketplace_supply_cells (marketplace, is_active);

-- ── one measurement per cell per day ───────────────────────────────────────
create table if not exists public.marketplace_supply_samples (
  id                 uuid primary key default gen_random_uuid(),
  cell_key           text not null,
  marketplace        text not null default 'ebay',
  brand_key          text,
  category_id        text not null,
  observed_on        date not null,
  -- eBay Browse `total`: live listings matching the cell's search.
  active_listings    bigint not null,
  -- Null below MIN_PRICE_SAMPLE. ask_sample_size records how thin, so a blank
  -- median is a measurement rather than an unexplained hole.
  median_ask_cents   bigint,
  ask_sample_size    int not null default 0,
  currency           text not null default 'USD',
  created_at         timestamptz not null default now(),
  constraint marketplace_supply_samples_listings_nonneg
    check (active_listings >= 0),
  constraint marketplace_supply_samples_sample_nonneg
    check (ask_sample_size >= 0),
  -- A cron that runs twice, or retries after a partial failure, must not put
  -- the same day into the trend twice.
  constraint marketplace_supply_samples_cell_day unique (cell_key, observed_on)
);

comment on table public.marketplace_supply_samples is
  'US-3132: daily live-listing counts per market cell. SUPPLY, not sales - the sold-price API is ungranted, so nothing built on this may claim sales rose or fell.';

create index if not exists marketplace_supply_samples_cell_day_idx
  on public.marketplace_supply_samples (cell_key, observed_on desc);
create index if not exists marketplace_supply_samples_day_idx
  on public.marketplace_supply_samples (observed_on desc);

-- ── deny-all, both directions (copied from 00663) ──────────────────────────
-- Readable, this table hands out the coverage map: which markets we watch and
-- how closely. Writable, anyone could move a number a public page prints.
alter table public.marketplace_supply_cells enable row level security;
alter table public.marketplace_supply_samples enable row level security;
revoke all on public.marketplace_supply_cells from anon, authenticated;
revoke all on public.marketplace_supply_samples from anon, authenticated;

-- ── the seed ───────────────────────────────────────────────────────────────
--
-- CATEGORY 11450 THROUGHOUT, AND THAT IS DELIBERATE. It is the one eBay leaf id
-- this repo has proven (style-code-discovery.ts EBAY_CLOTHING_CATEGORY_ID, and
-- five of the eight condition-index seeds). Inventing sharper leaf ids from
-- memory is exactly how a wrong number ships looking checked, so the search
-- term does the discriminating until the taxonomy cache is read on purpose.

-- 1. Category-only cells: the garment words, brand-agnostic. These are what
--    make a published index legible to somebody who sells none of the brands.
insert into public.marketplace_supply_cells (cell_key, marketplace, category_id, query_terms)
values
  ('|11450|jacket',            'ebay', '11450', 'jacket'),
  ('|11450|jeans',             'ebay', '11450', 'jeans'),
  ('|11450|hoodie',            'ebay', '11450', 'hoodie'),
  ('|11450|t-shirt',           'ebay', '11450', 't-shirt'),
  ('|11450|sweater',           'ebay', '11450', 'sweater'),
  ('|11450|dress',             'ebay', '11450', 'dress'),
  ('|11450|flannel shirt',     'ebay', '11450', 'flannel shirt'),
  ('|11450|leggings',          'ebay', '11450', 'leggings'),
  ('|11450|vintage tee',       'ebay', '11450', 'vintage tee'),
  ('|11450|carhartt jacket',   'ebay', '11450', 'carhartt jacket'),
  ('|11450|fleece',            'ebay', '11450', 'fleece'),
  ('|11450|boots',             'ebay', '11450', 'boots')
on conflict (cell_key) do nothing;

-- 2. Brand cells, taken from the knowledge base rather than typed here.
--    The 32 brands with the deepest colorway coverage are the ones whose
--    catalogues have actually been harvested (US-3125), which is the honest
--    proxy for "we know this brand well enough to measure its market".
--    32 brands x 6 garment terms = 192 cells, so the seed lands near 204.
insert into public.marketplace_supply_cells
  (cell_key, marketplace, brand_key, brand_display, category_id, query_terms)
select
  lower(trim(b.canonical_brand)) || '|11450|' || g.term,
  'ebay',
  b.brand_key,
  b.canonical_brand,
  '11450',
  g.term
from (
  select bk.brand_key, bk.canonical_brand
  from public.brand_knowledge bk
  join public.brand_colorways cw on cw.brand_key = bk.brand_key
  group by bk.brand_key, bk.canonical_brand
  order by count(*) desc, bk.brand_key
  limit 32
) b
cross join (values ('jacket'), ('jeans'), ('hoodie'), ('t-shirt'), ('sweater'), ('shirt'))
  as g(term)
on conflict (cell_key) do nothing;

insert into public.applied_migrations (version) values ('00745') on conflict do nothing;
