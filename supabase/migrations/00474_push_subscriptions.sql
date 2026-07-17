-- US-1901: Web push notifications — the subscription store.
--
-- Each row is one browser PushManager subscription belonging to a user. The
-- edge service (service-role client, bypasses RLS) fans notifications out to
-- every row for the recipient; the RLS policies below are defense-in-depth for
-- any direct PostgREST access with the user's own JWT (the frontend never reads
-- this table directly — it only POSTs to the edge /api/push/* routes).
--
-- `endpoint` is globally unique (a push endpoint identifies exactly one browser
-- install), so a re-subscribe from the same browser UPSERTs on the endpoint.

create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  endpoint      text not null,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  failure_count int not null default 0,
  constraint push_subscriptions_endpoint_key unique (endpoint)
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Per-user RLS: a user may only see/manage their own subscriptions.
drop policy if exists "Users read own push subscriptions" on public.push_subscriptions;
create policy "Users read own push subscriptions"
  on public.push_subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own push subscriptions" on public.push_subscriptions;
create policy "Users insert own push subscriptions"
  on public.push_subscriptions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own push subscriptions" on public.push_subscriptions;
create policy "Users update own push subscriptions"
  on public.push_subscriptions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own push subscriptions" on public.push_subscriptions;
create policy "Users delete own push subscriptions"
  on public.push_subscriptions for delete
  using (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00474') ON CONFLICT DO NOTHING;
