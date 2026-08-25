-- US-2853: quiet hours — a window where this account sends no push.
--
-- notification_preferences already answers "do you want this category at all",
-- per channel. It cannot answer "yes, but not at 3am", so the only lever a
-- seller woken by an offer alert had was to turn offers off permanently. That is
-- a preference screen making people choose between all and nothing.
--
-- ── WHAT IT MUTES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────
--
-- PUSH ONLY. The in-app row is still written and the email still sends, so
-- nothing is lost — the notification is waiting in the bell when they wake up.
--
-- The alternative was deferring: hold the push and fire it when the window ends.
-- That needs a queue, a drain job and a decision about what a six-hour-old
-- "offer received" push means when the offer has since expired. Muting is the
-- honest version of this feature and it is the version whose failure mode is
-- "you read it in the morning" rather than "you got paged about something that
-- is no longer true". If deferral is wanted later it is additive on top.
--
-- ── SHAPE ───────────────────────────────────────────────────────────────────
--
--   {"enabled": true, "start_hour": 22, "end_hour": 7, "tz": "America/Chicago"}
--
-- Hours are whole hours in the stored IANA zone, 0-23. start > end wraps over
-- midnight, which is the common case and therefore must not be an error. The
-- zone is stored rather than inferred because the send happens on a server in
-- UTC hours after the browser that knew the answer has gone.
--
-- NULL (the default) means no quiet hours, which is today's behaviour for every
-- existing row. `enabled: false` is a distinct, meaningful state: the seller
-- configured a window and switched it off, so the hours survive the toggle.
--
-- Idempotent; safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notification_quiet_hours jsonb;

COMMENT ON COLUMN public.users.notification_quiet_hours IS
  'Quiet hours for PUSH notifications only: {"enabled":bool,"start_hour":0-23,"end_hour":0-23,"tz":"IANA zone"}. start_hour > end_hour wraps midnight. NULL = never configured. In-app rows and email are unaffected, so nothing is lost while the window is open.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_notification_quiet_hours_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_notification_quiet_hours_check
      CHECK (
        notification_quiet_hours IS NULL
        OR (
          jsonb_typeof(notification_quiet_hours) = 'object'
          AND jsonb_typeof(notification_quiet_hours -> 'start_hour') = 'number'
          AND jsonb_typeof(notification_quiet_hours -> 'end_hour') = 'number'
          AND (notification_quiet_hours ->> 'start_hour')::int BETWEEN 0 AND 23
          AND (notification_quiet_hours ->> 'end_hour')::int BETWEEN 0 AND 23
        )
      );
  END IF;
END $$;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00669') ON CONFLICT DO NOTHING;
