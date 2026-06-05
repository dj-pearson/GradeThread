-- US-507: server-side feature flags / kill-switches.
--
-- Expensive / external-dependency flows (grading, autolister, content AI,
-- repricing) must be disable-able WITHOUT a redeploy — during an Anthropic
-- outage, a cost spike, or an incident. A DB-backed flag the edge reads (with a
-- short cache) is the kill-switch; flipping `enabled=false` makes the flow
-- return a graceful 503 / no-op within the cache TTL.

create table if not exists public.feature_flags (
  key         text primary key,
  enabled     boolean not null default true,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id) on delete set null
);

comment on table public.feature_flags is
  'US-507: runtime kill-switches for expensive/external flows. Missing row = enabled (fail-open for availability); enabled=false disables without a redeploy.';

-- Seed the known switches (enabled by default). ON CONFLICT keeps any operator
-- override if the migration is re-run.
insert into public.feature_flags (key, enabled, description) values
  ('grading',    true, 'AI grading pipeline (submit + retry).'),
  ('autolister', true, 'AutoLister bulk AI listing generation.'),
  ('content_ai', true, 'Content module AI generation (blog/social/images).'),
  ('repricing',  true, 'Condition-aware repricing scan + suggestions.')
on conflict (key) do nothing;

create or replace function public.set_feature_flags_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_feature_flags_updated_at on public.feature_flags;
create trigger trg_feature_flags_updated_at
  before update on public.feature_flags
  for each row execute function public.set_feature_flags_updated_at();

-- Service-role only. The SPA never reads flags directly (the edge enforces
-- them and returns 503); admins toggle via an audited edge route (US-476-style).
alter table public.feature_flags enable row level security;
revoke all on public.feature_flags from anon, authenticated;
