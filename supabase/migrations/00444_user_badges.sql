-- US-1850: achievements / badges — the EARNED table. The badge DEFINITIONS
-- catalog lives in code (lib/rewards-badges.ts) because a badge's criteria is a
-- predicate over the user's reward/grade stats — logic that can't live in a DB
-- row. This table records which catalog badge each user has unlocked, once.
-- (A DB display-mirror of the catalog for admin-editable metadata is an optional
-- future refinement; the code catalog is the source of truth.)

create table if not exists public.user_badges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  -- The catalog key (BADGE_CATALOG in rewards-badges.ts). Kept as free text so a
  -- new badge needs no enum migration; the code catalog is the validity source.
  badge_key  text not null,
  earned_at  timestamptz not null default now(),
  -- Snapshot of what earned it (the stat that crossed the threshold), for the
  -- shareable card + audit.
  context    jsonb not null default '{}'::jsonb
);

-- One award per (user, badge) — the award engine upserts idempotently, so a
-- re-evaluation never double-awards.
create unique index if not exists uq_user_badges_user_key
  on public.user_badges(user_id, badge_key);

alter table public.user_badges enable row level security;

drop policy if exists "Users read own badges" on public.user_badges;
create policy "Users read own badges"
  on public.user_badges for select
  using (auth.uid() = user_id);

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00444') ON CONFLICT DO NOTHING;
