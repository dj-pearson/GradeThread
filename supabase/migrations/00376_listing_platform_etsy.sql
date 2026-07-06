-- US-1659: add 'etsy' to the listing_platform enum.
--
-- Etsy is the next real-API marketplace FlipDesk connects (after eBay/Shopify,
-- alongside Depop). listings.platform and marketplace_connections.marketplace
-- are BOTH the public.listing_platform enum (00002 base + 00008 shopify/whatnot),
-- so the value must exist before any etsy connection row or sibling listing can
-- be written. The Etsy Open API v3 connection layer (etsy-client.ts) and adapter
-- ship in the same commit, gated behind ETSY_ENABLED until app approval — no row
-- carries platform='etsy' until an operator turns the connector on.
--
-- Idempotent (US-1108): ADD VALUE IF NOT EXISTS is safe to re-run, so re-running
-- the whole migrations directory (scripts/apply-prod-migrations.sh) is a no-op
-- once the value exists. NOT wrapped in a transaction: an enum value added inside
-- a transaction cannot be USED in that same transaction, and keeping the ADD
-- VALUE auto-committing avoids that class of foot-gun entirely (this migration
-- never uses the value itself). Depends on 00002 (enum) + 00008 (shopify/whatnot).

ALTER TYPE public.listing_platform ADD VALUE IF NOT EXISTS 'etsy';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00376')
ON CONFLICT (version) DO NOTHING;
