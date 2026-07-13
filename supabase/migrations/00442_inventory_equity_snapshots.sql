-- US-1870: Inventory Equity — daily equity-over-time snapshots.
--
-- A nightly job (jobs-equity-snapshot.ts) writes one row per user per day with
-- the tenant aggregate from the US-1869 model, powering the equity-over-time
-- trend chart. Tenant data (user_id): RLS lets a user read ONLY their own
-- snapshots; the job writes via the service-role client (bypasses RLS). Daily
-- idempotency via UNIQUE(user_id, snapshot_date) so a re-run upserts, never
-- double-inserts.

create table if not exists public.inventory_equity_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  snapshot_date      date not null,
  total_equity_cents bigint not null default 0,
  total_low_cents    bigint not null default 0,
  total_high_cents   bigint not null default 0,
  valued_count       integer not null default 0,
  unvalued_count     integer not null default 0,
  created_at         timestamptz not null default now()
);

create unique index if not exists idx_inventory_equity_snapshots_user_date
  on public.inventory_equity_snapshots(user_id, snapshot_date);

-- Trend reads scan a user's recent history newest-first.
create index if not exists idx_inventory_equity_snapshots_user_created
  on public.inventory_equity_snapshots(user_id, snapshot_date desc);

alter table public.inventory_equity_snapshots enable row level security;

drop policy if exists "Users read own equity snapshots"
  on public.inventory_equity_snapshots;
create policy "Users read own equity snapshots"
  on public.inventory_equity_snapshots for select
  using (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00442') ON CONFLICT DO NOTHING;
