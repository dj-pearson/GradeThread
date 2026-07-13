-- US-1849: Rewards XP/points engine — REUSES the reputation_events ledger (00417)
-- as the ONE event log for both the buyer Trust Score track AND the seller/user
-- XP track (US-1849 is explicit: do not build a parallel ledger). This adds the
-- reward-only event types + a user_reward_state cache. Reward events are IGNORED
-- by the trust scorer (computeTrustScore skips unknown types), so trust scoring
-- is unaffected; XP is derived from the same log by the rewards catalog.

-- Extend the event_type allow-list with the reward-only types. The 00417 inline
-- CHECK is named reputation_events_event_type_check by Postgres default; drop +
-- re-add idempotently so the whole set is authoritative and re-runnable.
alter table public.reputation_events
  drop constraint if exists reputation_events_event_type_check;
alter table public.reputation_events
  add constraint reputation_events_event_type_check check (event_type in (
    -- US-1816 buyer Trust Score types (unchanged):
    'verified_purchase', 'grade_confirmed', 'dispute_upheld',
    'dispute_overturned', 'chargeback_penalty', 'tenure',
    -- US-1849 reward-only types (carry XP via the catalog; score 0 for trust):
    'coverage_completed', 'badge_embedded', 'aspects_filled',
    'marketplace_connected', 'verified_share'
  ));

-- The XP/level cache — reconstructable from reputation_events at any time
-- (recomputeRewardState), like buyer_trust_scores is for the trust track.
create table if not exists public.user_reward_state (
  user_id        uuid primary key references public.users(id) on delete cascade,
  xp_total       bigint  not null default 0,
  level          integer not null default 0,
  current_streak integer not null default 0,
  longest_streak integer not null default 0,
  updated_at     timestamptz not null default now()
);

alter table public.user_reward_state enable row level security;

drop policy if exists "Users read own reward state" on public.user_reward_state;
create policy "Users read own reward state"
  on public.user_reward_state for select
  using (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00443') ON CONFLICT DO NOTHING;
