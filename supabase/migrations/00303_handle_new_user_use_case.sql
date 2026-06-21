-- US-1122: capture the new user's persona (`use_case`) at email signup.
--
-- signup.tsx now lets the user pick what brings them to GradeThread BEFORE the
-- account exists. That selection rides along in raw_user_meta_data (options.data)
-- exactly like full_name / the legal-consent fields, so handle_new_user can stamp
-- it on the profile row at creation. With use_case set from the start, the
-- dashboard personalizes on FIRST paint instead of waiting for the post-signup
-- OnboardingFlow modal to capture it.
--
-- The value is whitelisted to the same set as the users.use_case CHECK
-- ('seller','buyer','consignment','developer'); anything else (incl. NULL) stores
-- NULL so a malformed/absent client value can never violate the constraint and
-- abort signup. CREATE OR REPLACE keeps this idempotent; the rest of the function
-- is unchanged from 00079 (resilient + full_name sanitization + US-219 trial).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id, email, full_name, avatar_url, use_case,
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
    -- use_case is client-supplied at email signup; accept only valid personas.
    (CASE
       WHEN NEW.raw_user_meta_data ->> 'use_case'
            IN ('seller', 'buyer', 'consignment', 'developer')
       THEN NEW.raw_user_meta_data ->> 'use_case'
       ELSE NULL
     END),
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

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00303')
ON CONFLICT (version) DO NOTHING;
