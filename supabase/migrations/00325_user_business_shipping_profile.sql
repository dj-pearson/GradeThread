-- US-1442: reseller business + ship-from profile, entered once in Settings and
-- reused across marketplace/shipping flows (e.g. prefilling the eBay ship-from
-- location dialog) so it isn't re-supplied per marketplace.
--
-- These live on the user's own row — RLS already scopes public.users to the
-- authenticated user, so the fields are tenant-isolated with no extra policy.
-- All nullable (no default): a user who never fills them in is unaffected.
--
--   business_name      free-text business / store name
--   business_phone     contact phone for shipping/marketplace profiles
--   ship_from_address  jsonb { line1, line2, city, state, postal_code, country }
--
-- Idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run on any prior state.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS business_name text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS business_phone text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb;

COMMENT ON COLUMN public.users.ship_from_address IS
  'US-1442: { line1, line2, city, state, postal_code, country } — reseller ship-from address, prefilled into marketplace listing flows.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00325') ON CONFLICT DO NOTHING;
