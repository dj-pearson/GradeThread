-- US-2949: the seller's promotions, and what they actually did.
--
-- Markdown sales, coupons and volume discounts were created through FlipDesk
-- and then never looked at again: the promotions card re-fetched them from eBay
-- on every open, and nothing anywhere measured whether a sale sold more. So a
-- seller repeated discounts on the strength of a feeling.
--
-- Two things live here. The promotion itself, and the reported RESULT of it —
-- the result is a separate set of columns rather than a separate table because
-- there is exactly one result per promotion and a join for a one-to-one is a
-- join someone will forget.

CREATE TABLE IF NOT EXISTS public.marketplace_promotions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform              text NOT NULL DEFAULT 'ebay',
  external_promotion_id text NOT NULL,
  promotion_type        text,
  name                  text,
  status                text,
  discount_pct          numeric(5,2),
  starts_at             timestamptz,
  ends_at               timestamptz,
  item_count            integer,
  -- The reported result. Null until a report has been read, which is a real and
  -- common state: eBay does not report on a promotion that has not run yet.
  reported_units        integer,
  reported_revenue_cents integer,
  reported_at           timestamptz,
  raw                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, external_promotion_id)
);

-- The card lists a seller's promotions newest first; the lift comparison reads
-- the window a promotion ran in.
CREATE INDEX IF NOT EXISTS idx_marketplace_promotions_user_window
  ON public.marketplace_promotions(user_id, starts_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS set_marketplace_promotions_updated_at ON public.marketplace_promotions;
CREATE TRIGGER set_marketplace_promotions_updated_at
  BEFORE UPDATE ON public.marketplace_promotions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: a seller reads their own promotions and nothing else. The edge writes
-- through the service-role client, which bypasses this, so the edge ALSO filters
-- on user_id explicitly (US-268) — this policy is the second lock, not the only one.
ALTER TABLE public.marketplace_promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own marketplace promotions" ON public.marketplace_promotions;
CREATE POLICY "own marketplace promotions" ON public.marketplace_promotions
  -- US-1927: the wrapped INITPLAN form, so the session-user lookup hoists to a
  -- single initplan instead of being re-evaluated once per row.
  FOR SELECT USING ((select auth.uid()) = user_id);

COMMENT ON TABLE public.marketplace_promotions IS
  'US-2949: local record of a seller''s marketplace promotions (markdown sales, coupons, '
  'volume discounts) and the results eBay reports for them. eBay remains the source of '
  'truth for status; this exists so the promotions card opens without a live call and so '
  'lift can be measured at all. reported_* stay NULL until a report exists, which is the '
  'normal state for a promotion that has not run yet.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00677') ON CONFLICT DO NOTHING;
