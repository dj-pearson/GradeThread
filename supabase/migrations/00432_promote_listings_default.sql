-- FlipDesk: Promoted Listings default → OFF, opt-in per seller.
--
-- Old model promoted EVERY listing: listings.promo_opt_out defaulted false, and
-- publish read false as "promote". There was no way to say "this listing has no
-- explicit choice — follow my default". This migration flips promotion to
-- off-by-default with a per-seller opt-in, keeping the per-listing local
-- override:
--
--   publish promotes a listing when  promote_override ?? promote_listings_by_default
--
-- Per-seller defaults live on the user's own row. RLS scopes public.users to the
-- authenticated user, and guard_users_protected_columns (00076) does NOT list
-- these columns, so the seller can self-edit them from Settings — like the
-- ship-from profile (00325). Nullable rate/mode fall back to the category
-- suggestion / 'cps' at publish.
--
--   promote_listings_by_default  bool  when true, an un-configured listing is promoted
--   default_promo_rate_pct       num   seller default ad rate (%); null → category suggestion
--   default_promo_mode           text  seller default mode (cps|cpc|smart); null → cps
--
-- Per-listing tri-state override on listings:
--   promote_override  bool  NULL = inherit the seller default, true/false = explicit
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); safe to re-run the whole directory.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS promote_listings_by_default boolean NOT NULL DEFAULT false;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_promo_rate_pct numeric;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_promo_mode text;

COMMENT ON COLUMN public.users.promote_listings_by_default IS
  'FlipDesk: when true, a listing with no explicit promote_override is promoted at publish. Default false (off, opt-in).';
COMMENT ON COLUMN public.users.default_promo_rate_pct IS
  'FlipDesk: seller default eBay Promoted-Listings ad rate (%) applied when promoting a listing that has no per-listing rate. Null → category suggestion.';
COMMENT ON COLUMN public.users.default_promo_mode IS
  'FlipDesk: seller default Promoted Listings mode (cps|cpc|smart) for listings with no per-listing mode. Null → cps.';

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promote_override boolean;

COMMENT ON COLUMN public.listings.promote_override IS
  'FlipDesk: tri-state promotion choice — NULL inherits users.promote_listings_by_default, true/false is an explicit per-listing decision. Publish uses promote_override ?? seller default. Distinct from the legacy promo_opt_out boolean.';

-- Backfill: preserve EXPLICIT opt-outs. promo_opt_out=true is only ever set by a
-- deliberate seller action (composer save with promote off, or the DELETE
-- /promotion endpoint), so pin those to an explicit false — they stay off. Every
-- other listing stays NULL → inherits the (off-by-default) seller default, which
-- matches the "off by default going forward" intent. Live ads already on eBay
-- are untouched (this only affects the next publish/revise).
UPDATE public.listings
  SET promote_override = false
  WHERE promo_opt_out = true AND promote_override IS NULL;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00432') ON CONFLICT DO NOTHING;
