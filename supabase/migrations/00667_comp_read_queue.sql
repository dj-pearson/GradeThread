-- US-2845: the comp read queue, and the budget that can switch it off.
--
-- Three tables and two seed rows. Full contract and the demand-not-crawl
-- argument live in vault/20-domain/comp-read-worker.md (US-2059: knowledge in a
-- note, not in a header that can never be corrected).
--
-- All three are OPERATOR tables holding AGGREGATE MARKET DATA. No seller, no
-- listing, no tenant column, same posture as comp_condition_reads (00663).
-- Deny-all RLS; the service-role edge is the only path.

-- (1) the demand queue: which market cells our sellers actually touch.
create table if not exists public.comp_read_demand (
  cell_key       text primary key,
  category_id    text,
  brand          text,
  query          text,
  -- How many times a seller has asked about this cell. The ordering key.
  demand_count   bigint not null default 1,
  last_seen_at   timestamptz not null default now(),
  last_read_at   timestamptz,
  created_at     timestamptz not null default now()
);

comment on table public.comp_read_demand is
  'US-2845: market cells sellers have asked about, most-asked first. Aggregate demand only; no seller identity. There is no catalogue crawl.';

create index if not exists comp_read_demand_due_idx
  on public.comp_read_demand (demand_count desc, last_seen_at desc);

-- (2) the batch.
create table if not exists public.comp_read_batches (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'running',
  cells_total    int not null default 0,
  cells_done     int not null default 0,
  reads_written  int not null default 0,
  error          text,
  started_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz,
  constraint comp_read_batches_status_chk
    check (status in ('running', 'completed', 'failed'))
);

create index if not exists comp_read_batches_stale_idx
  on public.comp_read_batches (status, updated_at);

-- (3) one job per cell in a batch.
create table if not exists public.comp_read_jobs (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references public.comp_read_batches(id) on delete cascade,
  cell_key       text not null,
  status         text not null default 'pending',
  attempts       int not null default 0,
  reads_written  int not null default 0,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint comp_read_jobs_status_chk
    check (status in ('pending', 'running', 'completed', 'failed'))
);

create index if not exists comp_read_jobs_batch_idx
  on public.comp_read_jobs (batch_id, status);
-- The reclaim scan: a running job nobody has touched since JOB_STALE_MS.
create index if not exists comp_read_jobs_stale_idx
  on public.comp_read_jobs (status, updated_at);

alter table public.comp_read_demand enable row level security;
alter table public.comp_read_batches enable row level security;
alter table public.comp_read_jobs enable row level security;
revoke all on public.comp_read_demand from anon, authenticated;
revoke all on public.comp_read_batches from anon, authenticated;
revoke all on public.comp_read_jobs from anon, authenticated;

-- ── the kill switch, and the budget that pulls it ──────────────────────────
--
-- OFF. US-2842 has not returned a GO, and a worker that spends real money the
-- moment its migration lands is a worker whose gate was decorative. Flip this
-- on by hand after the spike says so.
insert into public.feature_flags (key, enabled, description) values
  ('comp_read', false, 'US-2845: background comp condition reads. OFF until the US-2842 calibration spike returns GO.')
on conflict (key) do nothing;

-- Action 'kill' flips the flag above off. The limit is deliberately small: the
-- first real number for dollars-per-read comes from US-2842, and a ceiling set
-- before you have measured the cost should be one you would not mind hitting.
insert into public.ai_budgets (feature, period, limit_usd, action, enabled)
select 'comp_read', 'day', 5.00, 'kill', true
where not exists (
  select 1 from public.ai_budgets where feature = 'comp_read' and period = 'day'
);

-- ── comp_read_demand_touch: increment, not read-modify-write ───────────────
--
-- The count has to go UP, and supabase-js has no atomic increment. Two edge
-- replicas serving two sellers in the same second would each read 4 and each
-- write 5, and the queue would under-count exactly the cells that are busiest.
-- One statement, and Postgres settles it.
-- SECURITY INVOKER, deliberately, and it is the safer of the two.
--
-- DEFINER would have to be, because the table is deny-all. INVOKER means the
-- caller's own grants decide, and the only caller is the service-role edge,
-- which has them. anon and authenticated get a clean table-permission denial
-- instead of a function they are allowed to run against a table they are not.
--
-- It also stays clear of US-2403: on the Supabase image, DENYING a function to
-- a supautils hint role (anon, authenticated, service_role) SEGFAULTS the
-- backend, which is why 00527 is parked as .BLOCKED. A DEFINER function here
-- would need exactly that revoke to be safe, so the shape that needs no revoke
-- is the shape to use.
create or replace function public.comp_read_demand_touch(
  p_cell_key    text,
  p_category_id text,
  p_brand       text,
  p_query       text
) returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.comp_read_demand (cell_key, category_id, brand, query)
  values (p_cell_key, p_category_id, p_brand, p_query)
  on conflict (cell_key) do update
    set demand_count = public.comp_read_demand.demand_count + 1,
        last_seen_at = now(),
        -- Keep whatever we already know: a later request that omits the brand
        -- must not blank a brand an earlier one supplied.
        category_id  = coalesce(excluded.category_id, public.comp_read_demand.category_id),
        brand        = coalesce(excluded.brand, public.comp_read_demand.brand),
        query        = coalesce(excluded.query, public.comp_read_demand.query);
$$;

comment on function public.comp_read_demand_touch(text, text, text, text) is
  'US-2845: record that a seller asked about this market cell. Atomic increment; no seller identity is stored. SECURITY INVOKER: the caller needs its own grants on comp_read_demand, which only the service role has.';

-- Say who may run it, rather than leaving it on the PostgREST default. No
-- REVOKE from anon/authenticated: see US-2403 above, and they cannot write the
-- table anyway now that this is INVOKER.
grant execute on function public.comp_read_demand_touch(text, text, text, text) to service_role;

insert into public.applied_migrations (version) values ('00667') on conflict do nothing;
