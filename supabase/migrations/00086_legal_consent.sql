-- US-377: capture explicit ToS/Privacy acceptance (clickwrap).
--
-- The signup page previously used passive browsewrap text ("by creating an
-- account you agree…") and recorded nothing; OAuth bypassed it entirely. We now
-- record an affirmative acceptance with the legal-document version + timestamp,
-- so consent is provable and a future material change can force re-acceptance.
--
-- tos_accepted_version stores the version string the user agreed to (the app's
-- CURRENT_LEGAL_VERSION at the time). tos_accepted_at is the server timestamp.
-- Both nullable: an OAuth signup (or a pre-existing account) has them NULL until
-- the in-app consent gate captures acceptance.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tos_accepted_version text,
  ADD COLUMN IF NOT EXISTS tos_accepted_at      timestamptz;

COMMENT ON COLUMN public.users.tos_accepted_version IS
  'US-377: legal-document version the user affirmatively accepted (clickwrap). '
  'NULL until accepted. When it differs from the app CURRENT_LEGAL_VERSION the '
  'consent gate re-prompts.';

-- Recreate handle_new_user to ALSO persist the acceptance passed at email
-- signup via options.data (raw_user_meta_data.tos_accepted_version). The
-- timestamp is set server-side (now()) only when a version is present, so a
-- client can't backdate consent. Everything else is preserved verbatim from
-- 00079 (resilient + sanitized + 14-day Pro trial). OAuth signups carry no such
-- metadata, so these stay NULL and the in-app gate captures them.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tos_version text := NULLIF(left(trim(NEW.raw_user_meta_data ->> 'tos_accepted_version'), 64), '');
BEGIN
  INSERT INTO public.users (
    id, email, full_name, avatar_url,
    flipdesk_plan, subscription_status, trial_ends_at,
    tos_accepted_version, tos_accepted_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(
      left(regexp_replace(trim(NEW.raw_user_meta_data ->> 'full_name'), '[[:cntrl:]]', '', 'g'), 200),
      ''
    ),
    left(NEW.raw_user_meta_data ->> 'avatar_url', 1000),
    'pro',
    'trialing',
    now() + interval '14 days',
    v_tos_version,
    CASE WHEN v_tos_version IS NOT NULL THEN now() ELSE NULL END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user: profile creation failed for % (%): %',
      NEW.id, NEW.email, SQLERRM;
    RETURN NEW;
END;
$$;
