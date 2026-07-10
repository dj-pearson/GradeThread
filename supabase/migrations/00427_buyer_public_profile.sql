-- US-1818: opt-in public buyer profile + granular privacy controls.
--
-- Mirrors the verified-seller profile (00057) but buyer-side and PRIVATE BY
-- DEFAULT: nothing is public until the buyer enables it and picks a handle, and
-- each stat is individually opt-in (buyer_profile_show). Edge-written (service
-- role) via the buyer profile route, so the users self-update guard is untouched.
-- The public read endpoint hard-filters to buyer_profile_enabled = true and only
-- emits the opted-in fields, so no PII leaks by construction.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS buyer_profile_handle  text,
  ADD COLUMN IF NOT EXISTS buyer_profile_enabled boolean NOT NULL DEFAULT false,
  -- { "level": true, "confirmations": true, "member_since": false } — each stat
  -- is opt-in; an absent/false key means "don't show it".
  ADD COLUMN IF NOT EXISTS buyer_profile_show    jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.users.buyer_profile_handle IS
  'US-1818: the public buyer-profile slug (/trust/:handle). Distinct namespace from verified_handle.';
COMMENT ON COLUMN public.users.buyer_profile_enabled IS
  'US-1818: when true, the buyer''s /trust/:handle profile is publicly readable. Default off (private).';

-- One handle per buyer, case-insensitive uniqueness (only among enabled/claimed
-- handles — a null handle doesn't participate).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_buyer_profile_handle
  ON public.users (lower(buyer_profile_handle))
  WHERE buyer_profile_handle IS NOT NULL;

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00427')
ON CONFLICT (version) DO NOTHING;
