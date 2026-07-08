-- US-1796: buyer/seller account roles — one identity, additive role flags.
--
-- The Buyer Platform (US-1794/1795) turns the seller-only product into a
-- two-sided buyer/seller platform. A person may buy, sell, or both, but must
-- keep ONE GradeThread identity (no duplicate logins). Rather than a join table
-- (which would churn RLS across the whole app), we add two additive boolean role
-- flags on public.users:
--
--   is_seller  — has the seller/FlipDesk role (the historical product).
--   is_buyer   — has the buyer role (dashboard, subscription, confidence suite).
--
-- BACKFILL: every existing account is a seller today, so is_seller defaults TRUE
-- (ADD COLUMN ... DEFAULT true stamps existing rows) and is_buyer defaults FALSE.
-- Existing seller signups are therefore completely unaffected.
--
-- These are ROLE MARKERS, not capability grants: seller features still gate on
-- flipdesk_plan/subscription_status (which the US-347 self-update guard freezes),
-- and buyer features will gate on the buyer plan (US-1800). They are deliberately
-- NOT added to the guard's protected-column list so a user can opt into the other
-- role in-app (AC: "a seller can opt into the buyer role and vice versa") — the
-- flag alone unlocks no paid capability.
--
-- handle_new_user() (SECURITY DEFINER) is extended so a BUYER-ORIGIN signup — the
-- new buyer funnel (US-1797) passes account_type='buyer' in raw_user_meta_data —
-- lands with is_buyer=true, is_seller=false, and NO FlipDesk/seller assumptions
-- (no 'pro' plan, no 'trialing' status, no 14-day trial). Any other value (incl.
-- the absent key from the existing seller signup path) keeps the historical
-- seller provisioning byte-for-byte, plus is_seller=true. account_type='both'
-- provisions both roles with the seller trial.

-- ── Role flags ──────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_seller boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_buyer  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.is_seller IS
  'US-1796: has the seller/FlipDesk role. Backfilled true for pre-buyer-platform accounts. Role marker only — seller capability gates on flipdesk_plan/subscription_status.';
COMMENT ON COLUMN public.users.is_buyer IS
  'US-1796: has the buyer role (buyer dashboard + subscription + confidence suite). Role marker only — buyer capability gates on the buyer plan (US-1800).';

-- Buyer-cohort lookups (admin buyer lists, buyer analytics) hit "where is_buyer".
CREATE INDEX IF NOT EXISTS idx_users_is_buyer ON public.users (id) WHERE is_buyer;

-- ── handle_new_user(): buyer-origin provisioning ────────────────────
-- CREATE OR REPLACE keeps this idempotent. Body is identical to 00379 except for
-- the account_type branch (roles + no-seller-assumptions for buyer-only signups).
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
BEGIN
  INSERT INTO public.users (
    id, email, full_name, avatar_url, use_case, signup_source,
    is_buyer, is_seller,
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
    v_is_buyer,
    v_is_seller,
    -- Buyer-only signups get NO seller trial (default free/none/no-trial); every
    -- other signup keeps the historical 14-day Pro trial (US-219) unchanged.
    (CASE WHEN v_buyer_only THEN 'free'::public.flipdesk_plan ELSE 'pro'::public.flipdesk_plan END),
    (CASE WHEN v_buyer_only THEN 'none'::public.subscription_status ELSE 'trialing'::public.subscription_status END),
    (CASE WHEN v_buyer_only THEN NULL ELSE now() + interval '14 days' END)
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
INSERT INTO public.applied_migrations (version) VALUES ('00401')
ON CONFLICT (version) DO NOTHING;
