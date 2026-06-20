-- US-932: internal behavioral event stream (trigger substrate).
--
-- Server-side PostHog (lib/posthog.ts) only fires OUT to analytics — there is no
-- internal store the drip / journey trigger engine (US-933, lib/drip-trigger.ts)
-- can query to decide "has first_grade happened since enrolled_at?". This is that
-- store: a thin, append-only log of the lifecycle actions the engine triggers on.
--
-- Service-role only: RLS enabled with an explicit `revoke all from anon,
-- authenticated` and ZERO policies by design. It is written + read ONLY by the
-- edge via the service-role client (lib/user-events.ts); the SPA never touches it
-- (it carries no client-facing data — analytics, not tenant content). The
-- rls-guard auto-discovers it via its user_id column and is satisfied by the
-- SERVICE_ROLE_ONLY classification in rls-guard_test.ts.
--
-- Additive + idempotent.

BEGIN;

-- ── Event log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_key   text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Nullable stable key for first-occurrence / once-only events (e.g.
  -- 'first_grade:<uid>'). UNIQUE so a re-emit is a no-op; plain (repeatable)
  -- events leave it NULL — Postgres treats each NULL as distinct, so they are
  -- never deduped.
  dedupe_key  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_events IS
  'US-932: append-only internal behavioral event stream the drip/journey trigger '
  'engine queries. Service-role only — never client-exposed.';

-- The hot query is "events of key K for user U, most-recent first" (the trigger
-- snapshot loads latest occurrence per key per user).
CREATE INDEX IF NOT EXISTS idx_user_events_user_key_time
  ON public.user_events (user_id, event_key, occurred_at DESC);

ALTER TABLE public.user_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_events FROM anon, authenticated;

-- ── Derived recency on users ─────────────────────────────────────────────────
-- A cheap, denormalized "last_active_at" maintained by lib/user-events.ts from
-- activity events (app_open / grade / listing / sale) so inactivity triggers
-- don't have to join across grade_reports/listings/sales every tick. Exposed to
-- the segment + trigger field allowlists (segment-predicates.ts).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

COMMENT ON COLUMN public.users.last_active_at IS
  'US-932: most-recent activity timestamp (signup/app_open/grade/listing/sale), '
  'maintained forward-only by lib/user-events.ts for cheap inactivity triggers.';

-- ── signup emission (DB-side) ────────────────────────────────────────────────
-- Signup happens via Supabase Auth (client-side) → the handle_new_user trigger
-- creates the profile row; there is NO edge action site to call emitEvent() from.
-- So the signup event is emitted here, AFTER the users row exists (an event row
-- FK-references it). Exception-guarded: an analytics write can never fail signup.
CREATE OR REPLACE FUNCTION public.emit_signup_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
    VALUES (NEW.id, 'signup', '{}'::jsonb, COALESCE(NEW.created_at, now()), 'signup:' || NEW.id)
    ON CONFLICT (dedupe_key) DO NOTHING;
    -- A brand-new user is active now; seed the recency signal forward-only.
    UPDATE public.users
      SET last_active_at = COALESCE(NEW.created_at, now())
      WHERE id = NEW.id AND last_active_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    -- swallow — never block account creation on the event stream
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emit_signup_event ON public.users;
CREATE TRIGGER trg_emit_signup_event
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.emit_signup_event();

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Seed first-occurrence lifecycle timestamps for EXISTING users so current
-- trialists enroll with correct history. Idempotent via dedupe_key.

-- signup ← users.created_at
INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
SELECT u.id, 'signup', '{"backfilled": true}'::jsonb, u.created_at, 'signup:' || u.id
FROM public.users u
ON CONFLICT (dedupe_key) DO NOTHING;

-- first_grade ← earliest grade_reports.created_at per user. grade_reports has no
-- user_id of its own — ownership flows through submissions.user_id.
INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
SELECT s.user_id, 'first_grade', '{"backfilled": true}'::jsonb,
       min(gr.created_at), 'first_grade:' || s.user_id
FROM public.grade_reports gr
JOIN public.submissions s ON s.id = gr.submission_id
WHERE s.user_id IS NOT NULL
GROUP BY s.user_id
ON CONFLICT (dedupe_key) DO NOTHING;

-- first_listing ← earliest listings.created_at per user
INSERT INTO public.user_events (user_id, event_key, properties, occurred_at, dedupe_key)
SELECT l.user_id, 'first_listing', '{"backfilled": true}'::jsonb,
       min(l.created_at), 'first_listing:' || l.user_id
FROM public.listings l
WHERE l.user_id IS NOT NULL
GROUP BY l.user_id
ON CONFLICT (dedupe_key) DO NOTHING;

-- last_active_at ← greatest of signup + latest real activity (only fills NULLs,
-- so a re-run never regresses a value the live path has since advanced).
UPDATE public.users u
SET last_active_at = GREATEST(
  u.created_at,
  COALESCE((SELECT max(gr.created_at) FROM public.grade_reports gr
              JOIN public.submissions sub ON sub.id = gr.submission_id
              WHERE sub.user_id = u.id), u.created_at),
  COALESCE((SELECT max(l.created_at)  FROM public.listings l      WHERE l.user_id  = u.id), u.created_at),
  COALESCE((SELECT max(s.created_at)  FROM public.sales s         WHERE s.user_id  = u.id), u.created_at)
)
WHERE u.last_active_at IS NULL;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00277')
ON CONFLICT (version) DO NOTHING;
