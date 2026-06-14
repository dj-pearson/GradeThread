-- US-886: feature flags v2 — gradual rollout + plan/user targeting + schedule.
--
-- Extends the global on/off kill-switch table (migration 00096) with optional
-- targeting, WITHOUT changing the existing kill-switch semantics:
--   • rollout_percentage — canary % of users (0–100), bucketed by a stable hash
--                          of key+userId in the edge resolver.
--   • plan_targets        — restrict to specific user plans (users.plan values).
--                           Empty = all plans.
--   • user_allow          — user ids the flag is ALWAYS on for (overrides %/plan).
--   • user_deny           — user ids the flag is ALWAYS off for (overrides
--                           %/plan/allow). A global kill still wins.
--   • starts_at / ends_at — optional scheduled enable/disable window.
--
-- BACKWARDS COMPATIBLE (AC#5): every existing flag loads as rollout 100% / no
-- plan targeting / empty allow+deny / no schedule — i.e. unchanged global on/off.
-- A global kill (enabled = false) ALWAYS wins over any targeting rule; the edge
-- resolver short-circuits on it before evaluating any of the columns below
-- (verified by feature-flags_test.ts). Existing no-userId kill-switch callers
-- ignore percentage + plan targeting entirely, so they keep working unchanged.

alter table public.feature_flags
  add column if not exists rollout_percentage int not null default 100
    check (rollout_percentage between 0 and 100),
  add column if not exists plan_targets text[]  not null default '{}',
  add column if not exists user_allow   uuid[]  not null default '{}',
  add column if not exists user_deny    uuid[]  not null default '{}',
  add column if not exists starts_at    timestamptz,
  add column if not exists ends_at      timestamptz;

comment on column public.feature_flags.rollout_percentage is
  'US-886: % of users the flag is on for (0-100), bucketed by a stable hash of key+userId in the edge resolver. 100 = everyone (default / legacy). Only gates userId-aware calls; no-userId kill-switch callers ignore it.';
comment on column public.feature_flags.plan_targets is
  'US-886: restrict the flag to these user plans (users.plan values). Empty = all plans. Only gates calls that supply a plan.';
comment on column public.feature_flags.user_allow is
  'US-886: user ids the flag is always ON for (overrides %/plan), as long as enabled=true and within any starts_at/ends_at window.';
comment on column public.feature_flags.user_deny is
  'US-886: user ids the flag is always OFF for (overrides %/plan/allow). A global kill (enabled=false) still wins.';
comment on column public.feature_flags.starts_at is
  'US-886: optional scheduled-enable time — before it the flag resolves OFF for everyone.';
comment on column public.feature_flags.ends_at is
  'US-886: optional scheduled-disable time — after it the flag resolves OFF for everyone.';
