-- US-596: Productize Grade-as-a-Service (B2B / white-label API).
--
-- The public grading API (US-063..066) + per-key auth, scopes, and plan-tiered
-- rate limits (US-356/US-800) already exist as internal plumbing. To position it
-- as a sellable product we add the two pieces of persisted state the product
-- surfaces need:
--
--   1. api_usage_events — an append-only request ledger so a partner can see, in
--      a usage/billing dashboard, how many API calls each key made, how many
--      succeeded vs errored, and how many were free sandbox calls. Distinct from
--      ai_usage_events (00163), which tracks our internal Anthropic token COST
--      per grade; this tracks the partner's API REQUEST volume per key.
--
--   2. users.partner_branding — white-label config (company name, brand color,
--      logo, support URL) the embeddable results widget (/embed/grade/:id) reads
--      so a partner platform can render a GradeThread grade under its own brand.
--
--   3. api_usage_summary() — a plain (invoker-rights) aggregation function the
--      edge dashboard endpoint calls. The edge uses the service-role client
--      (bypasses RLS) and always passes the workspace owner's id, so no
--      SECURITY DEFINER is needed; a direct authenticated call is still bounded
--      by the self-only RLS policy below.

-- ── 1. api_usage_events: per-request API call ledger ────────────────────────
create table if not exists public.api_usage_events (
  id           uuid primary key default gen_random_uuid(),
  -- Nullable + ON DELETE SET NULL so deleting a user or rotating-then-deleting a
  -- key never blocks on (nor deletes) the historical usage record.
  user_id      uuid references public.users(id) on delete set null,
  api_key_id   uuid references public.api_keys(id) on delete set null,
  -- The public API route family ('/grades', '/grades/:id', '/sandbox/grades',
  -- '/webhook', ...) — the :id param is normalized out so distinct ids collapse
  -- into one bucket for reporting.
  endpoint     text not null,
  method       text not null,
  status_code  integer not null default 0,
  -- Sandbox calls are free and consume no credits; flagged so billing can
  -- exclude them and the dashboard can show "live vs sandbox" volume.
  sandbox      boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists idx_api_usage_events_user_created
  on public.api_usage_events(user_id, created_at desc);

create index if not exists idx_api_usage_events_key_created
  on public.api_usage_events(api_key_id, created_at desc)
  where api_key_id is not null;

alter table public.api_usage_events enable row level security;

-- Self-only read: a partner can read their own usage ledger directly (the edge
-- dashboard uses the service-role client, which bypasses this, but the policy
-- keeps the table safe for any future authenticated direct read). Writes are
-- service-role only (the edge usage middleware), so there is no INSERT policy.
drop policy if exists "Users can read own API usage" on public.api_usage_events;
create policy "Users can read own API usage"
  on public.api_usage_events
  for select
  using (auth.uid() = user_id);

comment on table public.api_usage_events is
  'US-596: append-only ledger of public API (/api/v1) requests per key — powers '
  'the partner usage/billing dashboard. Sandbox calls are flagged + free.';

-- ── 2. users.partner_branding: white-label embed config ─────────────────────
-- jsonb (not columns) because the shape is presentational and may grow
-- (company_name, brand_color, logo_url, support_url, accent ...). Default {} so
-- existing rows read back an empty config (embed falls back to GradeThread
-- branding). Only the owner/admin edits it via the authed settings endpoint.
alter table public.users
  add column if not exists partner_branding jsonb not null default '{}'::jsonb;

comment on column public.users.partner_branding is
  'US-596: white-label branding for the embeddable grade widget '
  '(company_name, brand_color, logo_url, support_url).';

-- ── 3. api_usage_summary(): aggregation for the usage dashboard ─────────────
-- Returns one jsonb document: window bounds, totals (all / success / error /
-- sandbox), the busiest endpoints, and a per-day series. Plain STABLE function
-- (invoker rights): the service-role edge caller reads across the owner's rows;
-- a direct authenticated caller only sees their own rows via RLS, so passing
-- another user's id yields zeros rather than a leak.
create or replace function public.api_usage_summary(
  p_user_id uuid,
  p_days integer default 30
)
returns jsonb
language sql
stable
as $$
  with bounds as (
    select now() - (greatest(1, least(p_days, 365)) || ' days')::interval as since
  ),
  rows as (
    select *
    from public.api_usage_events e, bounds b
    where e.user_id = p_user_id
      and e.created_at >= b.since
  ),
  by_endpoint as (
    select endpoint, method, count(*)::int as count
    from rows
    group by endpoint, method
    order by count(*) desc
    limit 20
  ),
  daily as (
    select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
           count(*)::int as count
    from rows
    group by 1
    order by 1
  )
  select jsonb_build_object(
    'since', (select since from bounds),
    'days', greatest(1, least(p_days, 365)),
    'total_requests', (select count(*)::int from rows),
    'success_requests', (select count(*)::int from rows where status_code > 0 and status_code < 400),
    'error_requests', (select count(*)::int from rows where status_code >= 400),
    'sandbox_requests', (select count(*)::int from rows where sandbox),
    'by_endpoint', coalesce((select jsonb_agg(jsonb_build_object(
        'endpoint', endpoint, 'method', method, 'count', count)) from by_endpoint), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
        'day', day, 'count', count)) from daily), '[]'::jsonb)
  );
$$;

comment on function public.api_usage_summary(uuid, integer) is
  'US-596: aggregates api_usage_events for a user into a dashboard document '
  '(totals, by-endpoint, daily). Used by GET /api/keys/usage.';
