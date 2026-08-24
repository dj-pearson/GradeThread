-- US-2844: the comp condition sample store.
--
-- One row per comp listing we read for condition, keyed by the hash of its
-- photo set so a listing we have already paid to read costs nothing the next
-- time we meet it. AGGREGATE market data only: no seller, no listing id, no
-- URL, no title, no image bytes. It is a sample row, never an accusation about
-- somebody's listing (US-2841 standing constraint).
--
-- Deny-all RLS with zero policies, matching condition_price_curves (00098).
-- Written by the service-role edge; nothing client-side reads it.

create table if not exists public.comp_condition_reads (
  id                 uuid primary key default gen_random_uuid(),
  -- brand + item + category + marketplace, normalized. The unit of work.
  cell_key           text not null,
  -- Dedupe key: hash over the listing's ordered photo hashes.
  photo_set_hash     text not null unique,
  -- 1.0-10.0, null when the read was rejected before scoring.
  read_score         numeric(3,1),
  read_confidence    numeric(4,3),
  images_analyzed    int not null default 0,
  asking_price_cents bigint,
  currency           text not null default 'USD',
  -- Catalog/stock imagery (US-2843). A rejected read is kept, never fitted.
  stock_rejected     boolean not null default false,
  stock_reasons      text[] not null default '{}',
  created_at         timestamptz not null default now(),
  constraint comp_condition_reads_score_range
    check (read_score is null or (read_score >= 1.0 and read_score <= 10.0)),
  constraint comp_condition_reads_confidence_range
    check (read_confidence is null or (read_confidence >= 0 and read_confidence <= 1)),
  -- coalesce is load-bearing: array_length('{}', 1) is NULL, not 0, and a CHECK
  -- that evaluates to NULL PASSES. Without it this constraint accepts exactly
  -- the row it exists to refuse, silently, which is how it was written first.
  constraint comp_condition_reads_rejected_has_reason
    check (stock_rejected = false or coalesce(array_length(stock_reasons, 1), 0) >= 1)
);

comment on table public.comp_condition_reads is
  'US-2844: aggregate comp condition samples for price-vs-grade fitting. No PII, no listing identity, no image bytes.';

create index if not exists comp_condition_reads_cell_idx
  on public.comp_condition_reads (cell_key, created_at desc);
create index if not exists comp_condition_reads_fittable_idx
  on public.comp_condition_reads (cell_key)
  where stock_rejected = false and read_score is not null;

alter table public.comp_condition_reads enable row level security;
revoke all on public.comp_condition_reads from anon, authenticated;

insert into public.applied_migrations (version) values ('00663') on conflict do nothing;
