-- US-1670: capture a self-reported signup source at email signup (the "How did
-- you hear about us?" survey), with an "AI assistant" option.
--
-- Self-reported AI discovery is currently the only reliable ChatGPT/Claude/
-- Perplexity attribution (those referrers are often stripped), so this closes the
-- last gap in the SEO/GEO measurement layer: the analytics ai_referrer property
-- (US-1670, src/lib/analytics.ts) covers referrer-side attribution; this covers
-- self-reported discovery.
--
-- The selection rides along in raw_user_meta_data (options.data) exactly like
-- use_case (00303) / full_name / the legal-consent fields, so handle_new_user
-- stamps it on the users row at creation. The value is whitelisted to a fixed
-- set; anything else (incl. NULL / a malformed client value) stores NULL, so a
-- bad client value can never abort signup. CREATE OR REPLACE keeps this
-- idempotent; the function is otherwise identical to 00303.
--
-- Backward-compatible: the frontend passes an extra `signup_source` metadata key
-- that the OLD trigger simply ignored, so a frontend deploy that lands before
-- this migration applies degrades to "source not recorded" — it never breaks
-- signup. (Still held per the migration policy; see PENDING_MIGRATIONS.md.)

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS signup_source text;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id, email, full_name, avatar_url, use_case, signup_source,
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
    -- signup_source is self-reported at email signup (US-1670); whitelist to the
    -- known survey values, else NULL. Keep in sync with SIGNUP_SOURCE_VALUES in
    -- src/lib/constants.ts.
    (CASE
       WHEN NEW.raw_user_meta_data ->> 'signup_source'
            IN ('ai_assistant', 'search', 'social', 'reddit', 'youtube',
                'friend', 'reseller_community', 'ad', 'other')
       THEN NEW.raw_user_meta_data ->> 'signup_source'
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
INSERT INTO public.applied_migrations (version) VALUES ('00379')
ON CONFLICT (version) DO NOTHING;
