-- US-2425: record how COMPLETE each generated draft's eBay item specifics are.
--
-- Without a number, every change to the specifics pipeline (a wider capture, a
-- better category pick, a new projection) is an argument rather than a result.
-- This column stores the coverage of the draft at the moment it was generated,
-- so a regression in one vertical is visible instead of anecdotal.
--
-- Two tiers are kept SEPARATE on purpose: a missing REQUIRED aspect blocks the
-- publish outright, a missing RECOMMENDED one only costs search placement. A
-- single blended percentage would hide the difference that matters most.
--
-- Shape:
--   { "category_id": "57988",
--     "required":    { "filled": 5, "total": 6, "missing": ["Size Type"] },
--     "recommended": { "filled": 9, "total": 20, "missing": ["Fit", "Pattern"] },
--     "computed_at": "2026-08-07T12:00:00.000Z" }
-- `recommended.missing` is ranked by eBay's own 30-day buyer search volume.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS aspect_coverage jsonb;

COMMENT ON COLUMN public.listings.aspect_coverage IS
  'US-2425: eBay aspect coverage of this draft at generation time — required and recommended tiers kept separate, with the ranked missing names.';

-- The admin surface reads the most recent scored drafts grouped by leaf
-- category, so index exactly that access path and nothing else.
CREATE INDEX IF NOT EXISTS idx_listings_aspect_coverage_recent
  ON public.listings (updated_at DESC)
  WHERE aspect_coverage IS NOT NULL;

insert into public.applied_migrations (version) values ('00541') on conflict do nothing;
