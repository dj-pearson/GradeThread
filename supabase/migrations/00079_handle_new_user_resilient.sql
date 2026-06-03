-- US-376: make handle_new_user resilient + sanitize full_name.
--
-- The original trigger (00001) did a bare INSERT of the profile row. Two
-- problems:
--   1. Any failure (unique violation on a retried signup, a transient error,
--      a future NOT NULL/constraint) propagated out of the AFTER INSERT trigger
--      and ABORTED the auth.users insert — i.e. a profile hiccup broke signup
--      itself, and a retry could double-insert.
--   2. full_name / avatar_url were copied verbatim from raw_user_meta_data,
--      which is CLIENT-CONTROLLED at email signup (options.data). An unbounded
--      string (or megabytes of text) landed straight in the profile.
--
-- This version is idempotent (ON CONFLICT DO NOTHING), exception-safe (a profile
-- problem logs a warning and lets signup succeed — the row can be backfilled),
-- and length-caps the untrusted metadata. React escapes these on render, so the
-- cap is about storage/abuse, not XSS.
--
-- It PRESERVES the US-219 14-day Pro trial grant from 00037 (flipdesk_plan='pro',
-- subscription_status='trialing', trial_ends_at +14d). Re: US-366 — the trial is
-- set before email confirmation, but an UNVERIFIED account cannot use it: the
-- edge authMiddleware rejects every request from an unverified session (403) and
-- the daily trial-expiry cron reverts it to Free, so the grant is not
-- exploitable without a verified email.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id, email, full_name, avatar_url,
    flipdesk_plan, subscription_status, trial_ends_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    -- Trim, strip control chars, cap at 200 chars; empty -> NULL.
    NULLIF(
      left(regexp_replace(trim(NEW.raw_user_meta_data ->> 'full_name'), '[[:cntrl:]]', '', 'g'), 200),
      ''
    ),
    -- avatar_url is provider-supplied (OAuth); cap defensively.
    left(NEW.raw_user_meta_data ->> 'avatar_url', 1000),
    'pro',
    'trialing',
    now() + interval '14 days'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- A profile-row problem must NEVER abort the auth signup. Log + continue;
    -- the profile can be backfilled out of band.
    RAISE WARNING 'handle_new_user: profile creation failed for % (%): %',
      NEW.id, NEW.email, SQLERRM;
    RETURN NEW;
END;
$$;
