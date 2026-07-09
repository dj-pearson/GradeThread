-- US-1791: per-API-key monthly quota + rate-tier override (B2B API productization).
--
-- monthly_quota: max api_usage_events per UTC calendar month for the key
--   (NULL = unlimited). Enforced in api-key-auth.ts (429 quota_exceeded).
-- rate_tier: overrides the owner-plan-derived per-minute rate tier for this key
--   (NULL = derive from the owner's plan); set to 'enterprise' for the dedicated
--   high-throughput tier in API_RATE_TIERS.
-- Both additive + nullable, so existing keys behave exactly as before.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS monthly_quota integer,
  ADD COLUMN IF NOT EXISTS rate_tier text;

COMMENT ON COLUMN public.api_keys.monthly_quota IS
  'US-1791: max API calls per UTC month; NULL = unlimited. Enforced in api-key-auth.';
COMMENT ON COLUMN public.api_keys.rate_tier IS
  'US-1791: overrides the owner-plan per-minute rate tier (e.g. enterprise); NULL = derive from plan.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00409') on conflict do nothing;
