-- Restore the legal-acceptance capture that handle_new_user lost at 00303, and
-- make the recorded version server-resolved rather than client-claimed.
--
-- 00142 taught this trigger to record an email signup's clickwrap. 00303
-- replaced the function to add use_case and did not carry that block forward;
-- 00379 and 00401 rebased on the truncated body. So no email signup has
-- recorded a clickwrap since, and POST /api/legal/confirm-signup has refused
-- every caller for want of a row to corroborate.
--
-- The full account — the four acceptance methods, why the version is read from
-- legal_documents instead of the browser's constant, why accepted_at is now(),
-- and the rule that any future replacement of this function must be DIFFED
-- against the previous definition rather than written fresh — is in
-- vault/20-domain/signup-consent-capture.md. It is there and not here because
-- an applied migration is immutable and its header can never be corrected.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Whitelist the client-supplied role intent; anything else -> NULL (seller path).
  v_account_type text := (CASE
    WHEN NEW.raw_user_meta_data ->> 'account_type' IN ('buyer', 'seller', 'both')
    THEN NEW.raw_user_meta_data ->> 'account_type'
    ELSE NULL
  END);
  -- A buyer-ONLY signup gets no seller/FlipDesk assumptions.
  v_buyer_only boolean := COALESCE(v_account_type = 'buyer', false);
  v_is_buyer   boolean := COALESCE(v_account_type IN ('buyer', 'both'), false);
  -- Default (absent key) and seller/both stay sellers; only buyer-only is not.
  v_is_seller  boolean := COALESCE(v_account_type IS NULL OR v_account_type IN ('seller', 'both'), true);
  -- Presence of the clickwrap metadata = this was an email signup with a
  -- checkbox. The values are NOT used; only the fact that they were sent.
  v_clickwrap  boolean := NULLIF(NEW.raw_user_meta_data ->> 'tos_version', '') IS NOT NULL
                      AND NULLIF(NEW.raw_user_meta_data ->> 'privacy_version', '') IS NOT NULL;
  v_tos        text;
  v_privacy    text;
  v_at         timestamptz := now();
BEGIN
  IF v_clickwrap THEN
    SELECT d.version INTO v_tos
      FROM public.legal_documents d
     WHERE d.kind = 'tos'
     ORDER BY d.effective_date DESC, d.version DESC
     LIMIT 1;
    SELECT d.version INTO v_privacy
      FROM public.legal_documents d
     WHERE d.kind = 'privacy'
     ORDER BY d.effective_date DESC, d.version DESC
     LIMIT 1;
    -- Same baseline as FALLBACK_TOS_VERSION / FALLBACK_PRIVACY_VERSION, for a
    -- fresh database whose 00226 seed has not run.
    v_tos     := COALESCE(v_tos, '2026-04-01');
    v_privacy := COALESCE(v_privacy, '2026-04-01');
  END IF;

  INSERT INTO public.users (
    id, email, full_name, avatar_url, use_case, signup_source,
    is_buyer, is_seller,
    flipdesk_plan, subscription_status, trial_ends_at,
    tos_accepted_version, tos_accepted_at,
    privacy_accepted_version, privacy_accepted_at
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
    v_is_buyer,
    v_is_seller,
    -- Buyer-only signups get NO seller trial (default free/none/no-trial); every
    -- other signup keeps the historical 14-day Pro trial (US-219) unchanged.
    (CASE WHEN v_buyer_only THEN 'free'::public.flipdesk_plan ELSE 'pro'::public.flipdesk_plan END),
    (CASE WHEN v_buyer_only THEN 'none'::public.subscription_status ELSE 'trialing'::public.subscription_status END),
    (CASE WHEN v_buyer_only THEN NULL ELSE now() + interval '14 days' END),
    -- Only stamp the current-acceptance columns when the clickwrap metadata was
    -- supplied (email signup). OAuth signups leave these NULL for the gate.
    (CASE WHEN v_clickwrap THEN left(v_tos, 64) END),
    (CASE WHEN v_clickwrap THEN v_at END),
    (CASE WHEN v_clickwrap THEN left(v_privacy, 64) END),
    (CASE WHEN v_clickwrap THEN v_at END)
  )
  ON CONFLICT (id) DO NOTHING;

  -- The append-only audit row for an email clickwrap signup. This is the row
  -- POST /api/legal/confirm-signup corroborates; without it that endpoint
  -- refuses and the strengthened evidence is never recorded.
  IF v_clickwrap THEN
    INSERT INTO public.legal_acceptances (
      user_id, tos_version, privacy_version, method, accepted_at
    )
    VALUES (
      NEW.id, left(v_tos, 64), left(v_privacy, 64), 'signup_clickwrap', v_at
    );
  END IF;

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

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00586')
ON CONFLICT (version) DO NOTHING;
