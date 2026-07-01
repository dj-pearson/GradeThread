-- US-1447: cache the seller's Promoted Listings ADVANCED (Cost-Per-Click)
-- campaign + its default ad group on the connection, alongside the existing
-- COST_PER_SALE ebay_campaign_id (00157). CPC campaigns require an ad group, so
-- we cache both ids to avoid re-resolving them by name on every promote.
--
-- Edge-only columns (read/written via the service-role client in
-- ebay-marketing.ts); marketplace_connections already has RLS + a service-role
-- policy. Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS ebay_cpc_campaign_id text;

ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS ebay_cpc_ad_group_id text;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00329') ON CONFLICT DO NOTHING;
