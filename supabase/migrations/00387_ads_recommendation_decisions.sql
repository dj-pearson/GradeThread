-- US-1702: recommendation review workflow — snooze + dismiss state.
--
-- Adds the columns the review workflow needs on ads_recommendations (US-1701):
-- a snooze-until timestamp and an optional dismiss reason. The decision itself
-- (approve / dismiss / snooze, actor, timestamp, payload snapshot) is recorded as
-- an action='decision' row in the existing ads_change_audit ledger — no new table.
-- Additive + idempotent.

ALTER TABLE public.ads_recommendations
  ADD COLUMN IF NOT EXISTS snooze_until   timestamptz,
  ADD COLUMN IF NOT EXISTS dismiss_reason text;

-- The review list filters by status; a snoozed rec re-surfaces once snooze_until passes.
CREATE INDEX IF NOT EXISTS ads_recommendations_snooze_idx
  ON public.ads_recommendations (platform, status, snooze_until);

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00387') on conflict do nothing;
