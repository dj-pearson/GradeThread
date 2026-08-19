-- US-2675: record WHERE each mined demand term came from.
--
-- demand_terms (text[], migration 00154) keeps only the words. That was enough
-- while every term came from one place -- active eBay listings -- but the miner
-- now also reads titles of items that actually SOLD, and a seller looking at a
-- keyword chip has no way to tell which kind they are being offered.
--
-- Added alongside demand_terms rather than replacing it: every existing reader
-- (the listing prompt, the US-1892 title meter) wants the flat word list and is
-- untouched. Null on every pre-existing row and on any draft generated before
-- the sold corpus was available, which readers must treat as "unknown source",
-- not as "active".
--
-- Shape, one object per term, ordered highest-ranked first:
--   [{"term":"blanket lined","count":7,"source":"sold","lift":3.4}, ...]

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS demand_terms_detail jsonb;

COMMENT ON COLUMN public.listings.demand_terms_detail IS
  'US-2675: mined demand terms with provenance - [{term,count,source:sold|active,lift}], '
  'ranked. Parallel to demand_terms, which keeps the flat word list for existing readers. '
  'NULL means the source was never recorded, not that the terms were active-sourced.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00621') ON CONFLICT DO NOTHING;
