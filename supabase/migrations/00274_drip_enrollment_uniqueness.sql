-- US-936: Enrollment & state-machine engine — durable once-per-campaign guard.
--
-- The trial-conversion drip engine (routes/drip.ts) is the durable per-user
-- enrollment state machine this story specifies: drip_enrollments holds one row
-- per user per campaign run, advanced by the pure planner (lib/drip-graph.ts
-- planTick) against the persisted step-graph, with exit_reason recording the
-- terminal state (converted/unsubscribed/suppressed/completed) and
-- next_evaluation_at driving the bounded, resumable tick (00267). Per-step
-- idempotency is already DB-enforced by the UNIQUE (enrollment_id, step) index
-- on drip_sends (00272).
--
-- The one durability guarantee that was enforced only in application code
-- (enrollNewTrialists filters out users with an existing enrollment) is the
-- "a user enrolls once per campaign" invariant from AC1. This migration makes it
-- a DB-level constraint so a concurrent/retried enroll path can never create a
-- second enrollment for the same (user, campaign) — the engine's enroll insert
-- now upserts ON CONFLICT against this index, turning a duplicate into a no-op
-- instead of a failure.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS. Existing rows already satisfy
-- the invariant (the app-level filter has always prevented duplicates), so the
-- index builds cleanly on current data.

BEGIN;

create unique index if not exists drip_enrollments_user_campaign_uniq
  on public.drip_enrollments (user_id, campaign);

comment on index public.drip_enrollments_user_campaign_uniq is
  'US-936: a user enrolls at most once per campaign (entry-trigger idempotency).';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00274')
ON CONFLICT (version) DO NOTHING;
