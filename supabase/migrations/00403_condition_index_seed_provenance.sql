-- US-1746: provenance for auto-generated Value/Condition Index seeds.
--
-- The seed-generation cron (lib/condition-index-seedgen.ts) proposes new seeds
-- from real demand (graded brand×garment pairs + researched keywords) and inserts
-- them only after a trial comp fetch clears MIN_INDEX_TOTAL_SAMPLE. We tag each
-- seed with its provenance so the admin surface can tell hand-curated entries
-- from machine-proposed ones, and so a future audit / rollback can target only
-- the generated set. Purely additive + idempotent; existing rows default to
-- 'curated' (they predate generation).

ALTER TABLE public.condition_index_seeds
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'curated';

ALTER TABLE public.condition_index_seeds
  ADD COLUMN IF NOT EXISTS generated_at timestamptz;

-- Constrain source to the known provenances (idempotent: drop-then-add).
ALTER TABLE public.condition_index_seeds
  DROP CONSTRAINT IF EXISTS condition_index_seeds_source_check;
ALTER TABLE public.condition_index_seeds
  ADD CONSTRAINT condition_index_seeds_source_check
  CHECK (source IN ('curated', 'generated'));

COMMENT ON COLUMN public.condition_index_seeds.source IS
  'US-1746: ''curated'' (hand-added) or ''generated'' (proposed by the seed-gen cron from demand signals).';
COMMENT ON COLUMN public.condition_index_seeds.generated_at IS
  'US-1746: when the seed-gen cron proposed this seed (NULL for curated seeds).';

-- Query the generated set (admin review / audit) without scanning curated rows.
CREATE INDEX IF NOT EXISTS idx_condition_index_seeds_source
  ON public.condition_index_seeds (source);

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00403')
ON CONFLICT (version) DO NOTHING;
