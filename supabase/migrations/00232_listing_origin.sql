-- US-1077: listing_origin provenance marker on listings.
--
-- Authority direction (eBay↔FlipDesk sync) and the UI editing badge both key
-- off provenance, NOT the deprecated per-field source_of_truth pin (US-148,
-- retired by US-1078). Each listing is born either in GradeThread (published
-- from FlipDesk) or on eBay (imported/matched), and that origin is fixed.
--
-- Contract: SYNC_SOURCE_OF_TRUTH.md · registry: lib/sync-precedence.ts
-- (deriveListingOrigin mirrors the backfill signals below, so derived values
-- equal the stored marker — forward/backward compatible during rollout).

-- ── Enum type ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'listing_origin') THEN
    CREATE TYPE public.listing_origin AS ENUM ('gradethread', 'ebay');
  END IF;
END$$;

-- ── Column (nullable first so the backfill can classify before we lock it) ────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS listing_origin public.listing_origin;

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- GradeThread-originated: created via the FlipDesk publish path. batch_id (the
-- AutoLister publish batch) and synced_to_ebay_at (set only when WE pushed the
-- listing up to eBay) are stamped exclusively by our own code, so either one is
-- a definitive GT signal. These win over any eBay signal below.
UPDATE public.listings
  SET listing_origin = 'gradethread'
  WHERE listing_origin IS NULL
    AND (batch_id IS NOT NULL OR synced_to_ebay_at IS NOT NULL);

-- eBay-originated: lives on eBay but we never published it — either it was
-- matched/imported via flipdesk_ebay_listings, or it carries an eBay listing id
-- with no GT publish signal. (platform_offer_id is NOT used here: the inbound
-- pull stamps offer ids on eBay-imported rows too, so it can't distinguish.)
UPDATE public.listings AS l
  SET listing_origin = 'ebay'
  WHERE l.listing_origin IS NULL
    AND l.batch_id IS NULL
    AND l.synced_to_ebay_at IS NULL
    AND (
      (l.platform = 'ebay' AND l.platform_listing_id IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM public.flipdesk_ebay_listings fel
        WHERE fel.matched_item_id = l.inventory_item_id
      )
    );

-- Ambiguous rows (no clear GT or eBay signal — e.g. an unpublished manual draft)
-- default to the safe choice 'gradethread': it keeps the listing fully editable
-- and bidirectional rather than wrongly locking it to eBay. Matches
-- deriveListingOrigin()'s fallback. Logged for review.
DO $$
DECLARE
  ambiguous_count integer;
BEGIN
  SELECT count(*) INTO ambiguous_count
    FROM public.listings
    WHERE listing_origin IS NULL;
  IF ambiguous_count > 0 THEN
    RAISE NOTICE '[00232] % listing(s) had no clear provenance signal; defaulting to gradethread (review if unexpected).', ambiguous_count;
  END IF;
END$$;

UPDATE public.listings
  SET listing_origin = 'gradethread'
  WHERE listing_origin IS NULL;

-- ── Lock it down ─────────────────────────────────────────────────────────────
-- Every row is now classified. New rows default to 'gradethread'; all
-- listing-creation paths stamp the correct origin explicitly at insert time
-- (eBay import → 'ebay'), so the default only catches manual GT drafts.
ALTER TABLE public.listings
  ALTER COLUMN listing_origin SET DEFAULT 'gradethread';
ALTER TABLE public.listings
  ALTER COLUMN listing_origin SET NOT NULL;

COMMENT ON COLUMN public.listings.listing_origin IS
  'Provenance (US-1077): gradethread = published from FlipDesk; ebay = imported/matched from eBay. Drives sync authority direction + the UI editing badge. See SYNC_SOURCE_OF_TRUTH.md.';
