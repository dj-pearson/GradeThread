-- US-1447: per-listing Promoted Listings mode — 'cps' (Cost-Per-Sale, the
-- existing default) or 'cpc' (Cost-Per-Click / Priority). Drives which campaign
-- attachPromotionAtPublish uses. Additive column on the RLS-scoped listings
-- table; defaults to 'cps' so existing listings are unchanged.
-- Idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_mode text NOT NULL DEFAULT 'cps';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00330') ON CONFLICT DO NOTHING;
