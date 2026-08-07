-- US-1808: extension-fed marketplace listing ingestion.
--
-- A listing the buyer was looking at on a marketplace, handed to GradeThread by
-- the browser extension, graded, and evaluated against that buyer's saved
-- searches (00416). Private to the ingesting buyer; the edge writes it with the
-- service-role client scoped by user_id (US-268).
--
-- The full ToS/anti-crawl contract this table exists under lives in
-- services/edge-functions/src/lib/listing-ingest.ts and
-- vault/20-domain/buyer-platform.md — in short: one buyer-initiated listing per
-- request, marketplace hosts only, page HTML never fetched, rows pruned.

CREATE TABLE IF NOT EXISTS public.ingested_listings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Derived from the listing URL by the edge, never taken from the request body.
  marketplace        text NOT NULL,
  -- Canonical URL (scheme + host + path; query/fragment stripped). Doubles as
  -- the per-buyer dedupe key, so re-checking the same item updates one row.
  listing_url        text NOT NULL,
  -- Seller-claimed fields, verbatim, for the discrepancy comparison.
  title              text,
  brand              text,
  claimed_condition  text,
  price_cents        integer CHECK (price_cents IS NULL OR price_cents >= 0),
  -- One public marketplace photo, kept only so an alert can render a thumbnail.
  thumb_url          text,
  images_analyzed    integer NOT NULL DEFAULT 0,
  -- Our objective read (quickGrade). Nullable so a row can exist without one.
  overall_score      numeric(3,1) CHECK (overall_score IS NULL OR (overall_score >= 1.0 AND overall_score <= 10.0)),
  grade_tier         text,
  confidence         numeric(4,3),
  factor_scores      jsonb,
  -- The seller's claimed condition expressed on our 1–10 scale, and how far the
  -- objective grade falls below it (US-1834's scorer, persisted).
  claimed_grade      numeric(3,1),
  discrepancy        jsonb,
  -- saved_searches this listing matched on its most recent check.
  matched_search_ids uuid[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per (buyer, listing): re-checking an item the buyer already ingested
-- refreshes it rather than accumulating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingested_listings_url
  ON public.ingested_listings(user_id, listing_url);
-- Backs both the buyer's own reverse-chronological list and the retention prune.
CREATE INDEX IF NOT EXISTS idx_ingested_listings_user_created
  ON public.ingested_listings(user_id, created_at DESC);

DROP TRIGGER IF EXISTS set_ingested_listings_updated_at ON public.ingested_listings;
CREATE TRIGGER set_ingested_listings_updated_at
  BEFORE UPDATE ON public.ingested_listings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ingested_listings ENABLE ROW LEVEL SECURITY;

-- READ + DELETE for the owner, but NOT insert or update. The grade on this row
-- is GradeThread's objective read; letting the buyer write it client-side would
-- make "we graded it 9.5" a number the buyer could set. Delete IS allowed
-- (deliberately) because this is a record of the buyer's own browsing and they
-- must be able to remove it without asking us.
DROP POLICY IF EXISTS "Users read own ingested listings" ON public.ingested_listings;
CREATE POLICY "Users read own ingested listings"
  ON public.ingested_listings FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users delete own ingested listings" ON public.ingested_listings;
CREATE POLICY "Users delete own ingested listings"
  ON public.ingested_listings FOR DELETE
  USING ((select auth.uid()) = user_id);

-- ─── watchlist_items: a browsed listing is a watchable target ────────────────
-- 00416 modelled three target kinds. An ingested listing is a fourth: the buyer
-- can watch an item that is not on GradeThread at all. Kept as a CHECK (not an
-- enum) exactly so this widening needs no type surgery.
ALTER TABLE public.watchlist_items
  DROP CONSTRAINT IF EXISTS watchlist_items_target_type_check;
ALTER TABLE public.watchlist_items
  ADD CONSTRAINT watchlist_items_target_type_check
  CHECK (target_type IN ('certificate', 'listing', 'passport', 'ingested_listing'));

-- US-1108: self-record this migration's version so the edge schema-version
-- guard stays truthful regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00535')
ON CONFLICT (version) DO NOTHING;
