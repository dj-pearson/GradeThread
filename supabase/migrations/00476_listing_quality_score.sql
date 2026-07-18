-- US-1897 (AC2): persist the Listing Quality Score on the listing row so the
-- drafts list and pipeline board can SORT by it.
--
-- Sorting is the whole point. The score's value is triaging 300 drafts —
-- "which of these is worth my next ten minutes" — and that is a server-side
-- ORDER BY, not something the client can do over a page it has not fetched.
--
-- WHY THESE THREE COLUMNS AND NOT MORE. The component breakdown is deliberately
-- NOT stored. It is cheap to recompute (every input is already loaded by the
-- preflight), it changes whenever the weights change, and a stored copy would
-- silently go stale against the live rules — showing a seller a breakdown that
-- no longer matches the number beside it. Store the sortable scalar; recompute
-- the explanation on demand.
--
--   quality_score        0-100, NULL until first computed. NULL sorts distinctly
--                        from 0, which matters: "never scored" and "scored zero"
--                        are different states and a NOT NULL DEFAULT 0 would
--                        make every unscored draft look broken.
--   quality_blocked      true when a publish blocker capped the score. Stored
--                        rather than derived from `score <= 40` because the cap
--                        is a policy constant that may move; a persisted boolean
--                        keeps old rows honest if it does.
--   quality_scored_at    when it was computed, so a stale score is visible as
--                        stale rather than trusted.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS quality_score SMALLINT,
  ADD COLUMN IF NOT EXISTS quality_blocked BOOLEAN,
  ADD COLUMN IF NOT EXISTS quality_scored_at TIMESTAMPTZ;

-- Range guard: the score is a percentage by construction, so a value outside
-- 0-100 means a scorer bug, and it should fail at the write rather than quietly
-- corrupt a sort order. Added separately + idempotently (ADD CONSTRAINT has no
-- IF NOT EXISTS in older PG).
DO $$
BEGIN
  ALTER TABLE public.listings
    ADD CONSTRAINT listings_quality_score_range
    CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 100));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- The drafts/pipeline sort: worst-first within a seller's own rows.
-- Partial (score IS NOT NULL) because unscored rows are never in this sort, and
-- excluding them keeps the index small while the backlog is mostly unscored.
CREATE INDEX IF NOT EXISTS idx_listings_quality_score
  ON public.listings (inventory_item_id, quality_score)
  WHERE quality_score IS NOT NULL;

COMMENT ON COLUMN public.listings.quality_score IS
  'US-1897: 0-100 Listing Quality Score, recomputed on preflight. NULL = never '
  'scored (distinct from 0). Breakdown is intentionally not stored — it is '
  'recomputed so it can never drift from the live weights.';
COMMENT ON COLUMN public.listings.quality_blocked IS
  'US-1897: a publish blocker capped the score (missing required aspect, '
  'non-leaf category, sub-500px hero, …). Stored, not derived from the cap '
  'value, so old rows stay honest if the cap constant moves.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00476') ON CONFLICT DO NOTHING;
