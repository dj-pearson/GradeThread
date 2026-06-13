-- US-571: cross-replica cache coherence.
--
-- The edge service runs as multiple replicas (US-501). Some module-level caches
-- were per-process and broke once we scaled out: the eBay app token + GSC
-- service-account token were minted once PER replica, and the eval-gated
-- grading-prompt cache served a STALE prompt for up to its TTL after an
-- activation (which migration 00050 was meant to defend).
--
-- This table is the single Postgres-backed coherence store used by
-- services/edge-functions/src/lib/coherent-cache.ts (no Redis dependency, to
-- match the Postgres + Supavisor stack from US-570). It serves two roles:
--   * VALUE rows  — a cluster-shared bearer token (encrypted at rest), with an
--     expiry. Replicas read this before minting, so the cluster mints ~once per
--     TTL window instead of once per replica.
--   * SIGNAL rows — a monotonic `version` counter per cache_key. Writers bump it
--     on a mutation (e.g. prompt activation); readers poll it cheaply and drop
--     their stale local entry the instant the version moves.
-- A given cache_key is used for ONE of these roles, never both.

create table if not exists public.edge_shared_cache (
  cache_key  text primary key,
  -- Opaque payload for VALUE rows (e.g. an encrypted token); null for SIGNAL rows.
  value      text,
  -- Monotonic version for SIGNAL rows; ignored for VALUE rows.
  version    bigint not null default 1,
  -- Expiry for VALUE rows (token TTL); null when not applicable.
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.edge_shared_cache is
  'US-571: cross-replica cache coherence store. VALUE rows hold shared (encrypted) bearer tokens; SIGNAL rows hold a monotonic version bumped on cache-invalidating mutations.';

-- Atomically create-or-increment a signal version. Returns the NEW version, so
-- a writer can confirm the bump landed. A read-modify-write race between two
-- bumps is harmless: any change in the value is all a reader needs to detect
-- staleness, and the increment itself is atomic per call.
create or replace function public.bump_cache_signal(p_key text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_version bigint;
begin
  insert into public.edge_shared_cache (cache_key, version, updated_at)
  values (p_key, 1, now())
  on conflict (cache_key) do update
    set version    = public.edge_shared_cache.version + 1,
        updated_at = now()
  returning version into new_version;
  return new_version;
end;
$$;

comment on function public.bump_cache_signal(text) is
  'US-571: atomically increment (and create) a cache signal version; returns the new version.';

-- Current signal version for a key; 0 when the key has never been bumped (so a
-- reader on a brand-new cluster treats its first fetch as version 0).
create or replace function public.get_cache_signal(p_key text)
returns bigint
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (select version from public.edge_shared_cache where cache_key = p_key),
    0
  );
$$;

comment on function public.get_cache_signal(text) is
  'US-571: read a cache signal version; 0 if never bumped.';

-- The edge service uses the service-role key; lock the table + functions down so
-- they are not reachable by anon/authenticated PostgREST clients.
alter table public.edge_shared_cache enable row level security;
-- No policies: with RLS on and no policy, anon/authenticated get nothing; the
-- service-role key bypasses RLS entirely.

revoke all on table public.edge_shared_cache from anon, authenticated;
revoke all on function public.bump_cache_signal(text) from public, anon, authenticated;
revoke all on function public.get_cache_signal(text) from public, anon, authenticated;
