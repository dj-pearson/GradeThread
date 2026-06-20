-- US-912: Standalone email subscriber list (non-user leads).
--
-- email_subscribers already exists (US-931, migration 00278) as the confirmed-
-- subscriber registry feeding newsletter_analytics. This migration extends it
-- into a full double-opt-in capture surface for landing-page leads who have NOT
-- created an account yet, while keeping consent + suppression unified with
-- registered users:
--   • a `consent_token` (the double-opt-in confirm secret) + a unique index,
--   • a `bounced` status so the SES suppression loop (US-914) can mark a
--     standalone lead's row identically to how a user is suppressed,
--   • a trigger on public.users that LINKS a subscriber row to the new account
--     (by normalized email) the moment a lead registers — so the send-side
--     union (broadcast-audience.partitionExtraSubscribers) de-dupes by email and
--     the person is never emailed twice.
--
-- Additive + idempotent.

BEGIN;

-- ── consent_token (double-opt-in confirm secret) ────────────────────────────
ALTER TABLE public.email_subscribers
  ADD COLUMN IF NOT EXISTS consent_token text;

COMMENT ON COLUMN public.email_subscribers.consent_token IS
  'US-912: opaque double-opt-in confirmation secret. Set on a pending signup; '
  'the public GET /api/newsletter/confirm endpoint matches it to flip the row to '
  'confirmed, then it is cleared. NULL once confirmed/unsubscribed.';

-- A given token addresses exactly one pending row (no enumeration: an unknown
-- token simply matches nothing). Partial so the many confirmed/null rows don't
-- collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS email_subscribers_consent_token_idx
  ON public.email_subscribers (consent_token)
  WHERE consent_token IS NOT NULL;

-- ── 'bounced' status (suppression parity with users — AC4) ──────────────────
-- The inline CHECK from 00278 is auto-named email_subscribers_status_check.
-- Drop + re-add widening the allowed set ('cleaned' kept for back-compat).
ALTER TABLE public.email_subscribers
  DROP CONSTRAINT IF EXISTS email_subscribers_status_check;
ALTER TABLE public.email_subscribers
  ADD CONSTRAINT email_subscribers_status_check
  CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'bounced', 'cleaned'));

-- ── Link a lead's subscriber row to their new account on signup (AC3) ───────
-- When someone who subscribed as a standalone lead later registers, claim their
-- email_subscribers row for the new user so the segment/subscriber UNION dedups
-- by email (they aren't mailed twice). Best-effort: an exception here must never
-- block account creation. SECURITY DEFINER so it can write the deny-all
-- (service-role-only) email_subscribers table from within the signup path.
CREATE OR REPLACE FUNCTION public.link_email_subscriber_to_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    UPDATE public.email_subscribers
       SET user_id    = NEW.id,
           updated_at = now()
     WHERE user_id IS NULL
       AND email = lower(trim(NEW.email));
  EXCEPTION WHEN OTHERS THEN
    -- Never let subscriber bookkeeping break signup.
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_email_subscriber_to_user ON public.users;
CREATE TRIGGER trg_link_email_subscriber_to_user
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.link_email_subscriber_to_user();

COMMENT ON FUNCTION public.link_email_subscriber_to_user() IS
  'US-912: on new-account creation, claim any standalone email_subscribers lead '
  'row matching the user''s email so the marketing union de-dupes by email.';

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00295')
ON CONFLICT (version) DO NOTHING;
