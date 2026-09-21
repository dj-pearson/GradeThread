-- Worth My Time, R1 01/12 (US-3166): where a seller works, what they have to
-- work with, and what their time is worth to them.
--
-- One row per seller, created lazily on first save; an absent row means every
-- default, which is why every column is NOT NULL with one. The planner that
-- reads these lands in R1 06/12; this only stores them.
--
-- SHAPE NOTES, each of which is a decision rather than a default:
--
-- hourly_target_amount IS NULLABLE AND NULL IS NOT ZERO. A planner reading 0
-- would rank every task as infinitely worth doing; one reading NULL knows it
-- cannot rank on money and has to say so. The screen shows "not set".
--
-- hourly_target_currency is NOT NULL even though this release supports USD
-- only. Storing it explicitly means the day conversion arrives, the rows
-- already on disk are unambiguous rather than assumed.
--
-- available_tools is a text[] with a CHECK against the closed set rather than
-- an enum, because a tool belongs here only when a task is gated on it, and
-- adding an enum value is a migration that cannot be undone while dropping a
-- CHECK is one line.
--
-- settings_version records the MEANING of the stored fields, so a later
-- release can tell a row it wrote from one it inherited. It is not a row
-- version and not a concurrency token; updated_at is for that.

CREATE TABLE IF NOT EXISTS public.flipdesk_work_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  default_session_minutes integer NOT NULL DEFAULT 30,
  work_context            text NOT NULL DEFAULT 'home',
  available_tools         text[] NOT NULL DEFAULT ARRAY['camera']::text[],
  hourly_target_amount    numeric(10,2),
  hourly_target_currency  text NOT NULL DEFAULT 'USD',
  settings_version        integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.flipdesk_work_preferences IS
  'US-3166 (Worth My Time R1 01/12): per-seller planning inputs. Absent row = all defaults.';
COMMENT ON COLUMN public.flipdesk_work_preferences.hourly_target_amount IS
  'US-3166: what an hour of this seller''s time is worth to them, or NULL for not set. NULL is NOT zero -- a planner reading 0 would rank every task as infinitely worth doing.';
COMMENT ON COLUMN public.flipdesk_work_preferences.settings_version IS
  'US-3166: bumped when the MEANING of a stored field changes. Not a row version; updated_at is for that.';

ALTER TABLE public.flipdesk_work_preferences
  DROP CONSTRAINT IF EXISTS flipdesk_work_preferences_minutes_chk;
ALTER TABLE public.flipdesk_work_preferences
  ADD CONSTRAINT flipdesk_work_preferences_minutes_chk
  CHECK (default_session_minutes BETWEEN 5 AND 240);

ALTER TABLE public.flipdesk_work_preferences
  DROP CONSTRAINT IF EXISTS flipdesk_work_preferences_context_chk;
ALTER TABLE public.flipdesk_work_preferences
  ADD CONSTRAINT flipdesk_work_preferences_context_chk
  CHECK (work_context IN ('home', 'phone_only'));

ALTER TABLE public.flipdesk_work_preferences
  DROP CONSTRAINT IF EXISTS flipdesk_work_preferences_tools_chk;
ALTER TABLE public.flipdesk_work_preferences
  ADD CONSTRAINT flipdesk_work_preferences_tools_chk
  CHECK (available_tools <@ ARRAY['camera', 'measuring_tape', 'steamer', 'packing_supplies']::text[]);

ALTER TABLE public.flipdesk_work_preferences
  DROP CONSTRAINT IF EXISTS flipdesk_work_preferences_currency_chk;
ALTER TABLE public.flipdesk_work_preferences
  ADD CONSTRAINT flipdesk_work_preferences_currency_chk
  CHECK (hourly_target_currency = 'USD');

-- A target of exactly 0 is legal: a seller may deliberately say their time is
-- free. What is refused is a negative one, which is not a statement about time.
ALTER TABLE public.flipdesk_work_preferences
  DROP CONSTRAINT IF EXISTS flipdesk_work_preferences_target_chk;
ALTER TABLE public.flipdesk_work_preferences
  ADD CONSTRAINT flipdesk_work_preferences_target_chk
  CHECK (hourly_target_amount IS NULL OR hourly_target_amount >= 0);

DROP TRIGGER IF EXISTS set_flipdesk_work_preferences_updated_at
  ON public.flipdesk_work_preferences;
CREATE TRIGGER set_flipdesk_work_preferences_updated_at
  BEFORE UPDATE ON public.flipdesk_work_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_work_preferences ENABLE ROW LEVEL SECURITY;

-- Owner-scoped SELECT only, and no write policy at all.
--
-- Reads and writes both go through the authenticated edge routes, which
-- resolve the WORKSPACE OWNER (US-3166 AC4) -- a team member gets the
-- workspace's settings, which their own auth.uid() could never select. So the
-- SELECT policy is defence in depth for a direct client read of a seller's own
-- row, and writes are service-role only because a direct write would bypass
-- the validation the route performs.
DROP POLICY IF EXISTS "Users can view own work preferences"
  ON public.flipdesk_work_preferences;
-- (select auth.uid()), not a bare auth.uid() (US-1927). The bare form is a
-- volatile call Postgres re-evaluates PER ROW; wrapped in a scalar subquery it
-- is hoisted into an InitPlan and runs once for the whole query.
CREATE POLICY "Users can view own work preferences"
  ON public.flipdesk_work_preferences FOR SELECT
  USING ((select auth.uid()) = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.flipdesk_work_preferences FROM anon, authenticated;

insert into public.applied_migrations (version) values ('00817') on conflict do nothing;
