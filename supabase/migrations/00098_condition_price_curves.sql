-- US-611: persisted condition price curves (price-vs-grade per item).
--
-- A curve is the condition-value engine (US-610) evaluated across the grade
-- scale for one item identity (brand + category + keyword). Caching it lets the
-- public Condition Index (US-621) render without a live eBay call per pageview
-- and lets ScoutAI margin ranking (US-617) reuse a recent curve. Curves are
-- AGGREGATE only — no per-listing or per-seller data, no PII.

create table if not exists public.condition_price_curves (
  id            uuid primary key default gen_random_uuid(),
  -- Normalized identity: lower("brand|categoryId|query"). One row per item key.
  item_key      text not null unique,
  brand         text,
  category_id   text not null,
  query         text,
  currency      text not null default 'USD',
  -- [{ grade, low_cents, median_cents, high_cents, sample_size, sufficient }]
  curve         jsonb not null,
  total_sample_size int not null default 0,
  refreshed_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

comment on table public.condition_price_curves is
  'US-611: cached price-vs-grade curves per item identity (aggregate eBay comps, no PII).';

create index if not exists condition_price_curves_brand_idx
  on public.condition_price_curves (brand);
create index if not exists condition_price_curves_refreshed_idx
  on public.condition_price_curves (refreshed_at);

-- Aggregate, non-tenant data. Written by the service-role edge; the public Index
-- is server-rendered by the edge (which bypasses RLS), so no anon policy is
-- needed. RLS on with zero policies = deny-all to anon/authenticated.
alter table public.condition_price_curves enable row level security;
revoke all on public.condition_price_curves from anon, authenticated;
