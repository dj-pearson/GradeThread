-- US-9212: the tax identity a creator must file before any cash moves.
--
-- vault/60-decisions/adr-referral-cash-payout.md section 4.5 is the gate: no
-- cash moves before W-9 capture and 1099 threshold tracking exist. The
-- threshold FLAG already existed (affiliate_payout_config.tax_threshold_usd);
-- the identity did not, so the payout engine could pay a creator we could not
-- report. planPayout now refuses without a certified row here, and this table
-- is where that row lives.
--
-- DENY-ALL, service-role only. The browser never reads this: a creator sees
-- their own status through an edge route that returns a status and the last
-- four digits, never the ciphertext. The owner column is `owner_user_id` and
-- the literal `user_id` is kept out of the CREATE TABLE, per the rls-guard
-- service-role-table convention; the table is registered in SERVICE_ROLE_ONLY
-- in services/edge-functions/src/tests/rls-guard_test.ts in the same commit.
--
-- THE TIN IS CIPHERTEXT. tin_encrypted holds an AES-256-GCM envelope written by
-- the edge (lib/crypto-aes.ts), whose key never reaches the browser, and
-- tin_last4 is the only plaintext fragment stored -- enough to confirm which
-- number is on file, useless on its own.

CREATE TABLE IF NOT EXISTS public.affiliate_tax_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  legal_name     text NOT NULL,
  entity_type    text NOT NULL
                 CHECK (entity_type IN (
                   'individual','sole_proprietor','single_member_llc',
                   'c_corp','s_corp','partnership','trust','other'
                 )),
  -- AES-256-GCM envelope written by the edge. Never selected by the client.
  tin_encrypted  text,
  tin_last4      text CHECK (tin_last4 IS NULL OR tin_last4 ~ '^[0-9]{4}$'),
  address_line1  text,
  address_line2  text,
  city           text,
  region         text,
  postal_code    text,
  country        text NOT NULL DEFAULT 'US',
  -- When the creator certified the form. NULL means started but not certified,
  -- which the payout gate treats exactly like no row at all.
  certified_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_tax_profiles_certified
  ON public.affiliate_tax_profiles (owner_user_id) WHERE certified_at IS NOT NULL;

ALTER TABLE public.affiliate_tax_profiles ENABLE ROW LEVEL SECURITY;
-- Deny-all on purpose: no policies. The service role bypasses RLS.

DROP TRIGGER IF EXISTS set_affiliate_tax_profiles_updated_at ON public.affiliate_tax_profiles;
CREATE TRIGGER set_affiliate_tax_profiles_updated_at
  BEFORE UPDATE ON public.affiliate_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.affiliate_tax_profiles IS
  'US-9212: creator tax identity (the W-9 equivalent). Deny-all; the edge is the only reader. A certified row is required before any affiliate cash payout fires.';

-- US-9212: the creator commission model the founder decided on 2026-09-01.
-- Merged into the existing config rather than replacing it, so a deployment
-- that already edited mode or minimum_payout keeps its values. mode stays off.
UPDATE public.system_settings
   SET default_value = default_value || jsonb_build_object(
         'commission_model', 'subscription_pct',
         'commission_pct', 25,
         'commission_cap_usd', 250,
         'commission_window_months', 12
       )
 WHERE key = 'affiliate_payout_config';

insert into public.applied_migrations (version) values ('00718') on conflict do nothing;
