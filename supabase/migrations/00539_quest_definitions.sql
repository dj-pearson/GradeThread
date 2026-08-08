-- US-1852: quests & time-boxed challenges. Operator-configured DEFINITIONS only.
--
-- What is deliberately NOT here: a per-user progress table. Progress is derived
-- from reputation_events over the quest's window, the same way US-1851 derives
-- season progress — one log, no second source of truth to fall out of sync, and
-- no rollover job at a window boundary. See vault/20-domain/reward-ledger.md.
--
-- The criteria PREDICATE is not stored either. `criteria_key` names a predicate
-- defined in services/edge-functions/src/lib/rewards-quests.ts, so an operator
-- picks from a reviewed, tested set rather than authoring rules in a text column
-- that nothing can type-check.

-- The quest_completed event type. Quests pay through the same grantReward
-- primitive as everything else, so the UNIQUE(user_id, event_type, reference_id)
-- dedupe key is what stops a quest paying twice.
alter table public.reputation_events
  drop constraint if exists reputation_events_event_type_check;
alter table public.reputation_events
  add constraint reputation_events_event_type_check check (event_type in (
    -- US-1816 buyer Trust Score types:
    'verified_purchase', 'grade_confirmed', 'dispute_upheld',
    'dispute_overturned', 'chargeback_penalty', 'tenure',
    -- US-1849 reward-only types:
    'coverage_completed', 'badge_embedded', 'aspects_filled',
    'marketplace_connected', 'verified_share',
    -- US-1852 quest completion (XP read from metadata, clamped in code):
    'quest_completed'
  ));

create table if not exists public.quest_definitions (
  id            uuid primary key default gen_random_uuid(),
  -- Stable slug. It is the dedupe reference a completion is keyed on, so
  -- renaming a live quest would re-pay everyone who already finished it.
  quest_key     text not null unique,
  title         text not null,
  description   text not null default '',
  -- Names a predicate in rewards-quests.ts. Unknown keys are ignored at read
  -- time rather than erroring, so a rollback of the code cannot break the table.
  criteria_key  text not null,
  target        integer not null check (target > 0),
  xp_reward     integer not null default 0 check (xp_reward >= 0),
  scope         text not null default 'personal'
                  check (scope in ('personal', 'community')),
  -- 'weekly'/'monthly' quests repeat on a rolling window; 'fixed' runs once
  -- between starts_at and ends_at.
  window_kind   text not null default 'weekly'
                  check (window_kind in ('weekly', 'monthly', 'fixed')),
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- Fail-closed: a freshly inserted quest awards nothing until an operator
  -- turns it on, so a half-configured row can never start paying.
  enabled       boolean not null default false,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A fixed-window quest without a window is not configurable, it is a bug.
  constraint quest_definitions_fixed_window_check
    check (window_kind <> 'fixed' or (starts_at is not null and ends_at is not null)),
  constraint quest_definitions_window_order_check
    check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists idx_quest_definitions_enabled
  on public.quest_definitions (enabled, sort_order)
  where enabled = true;

drop trigger if exists trg_quest_definitions_updated_at on public.quest_definitions;
create trigger trg_quest_definitions_updated_at
  before update on public.quest_definitions
  for each row execute function public.set_updated_at();

-- Operator table: deny-all RLS, reachable only through the service-role client
-- behind the admin scope guard. There is no owner column because a quest
-- definition belongs to the product, not to a tenant.
alter table public.quest_definitions enable row level security;
drop policy if exists quest_definitions_deny_all on public.quest_definitions;
create policy quest_definitions_deny_all on public.quest_definitions
  for all using (false) with check (false);

comment on table public.quest_definitions is
  'US-1852 operator-configured quest/challenge definitions. Progress is derived from reputation_events, never stored here.';

insert into public.applied_migrations (version) values ('00539') on conflict do nothing;
