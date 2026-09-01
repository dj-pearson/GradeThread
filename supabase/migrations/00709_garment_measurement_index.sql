-- 00709 — the Fit & Measurement Index storage (US-3033)
--
-- Every clothing brand publishes BODY size charts. Almost nobody publishes
-- flat-lay GARMENT measurements, which is what a resale listing is actually
-- written with. 00674 confirms that from inside this schema: all 292 seeded
-- brand_size_charts rows are measurement_basis='body', and its comment quotes
-- 00452 saying "All BODY measurements, never flat-garment".
--
-- Two tables, two very different privacy classes:
--
--   garment_measurements       one row per garment per measured field.
--                              TENANT-SCOPED. It is the seller's own inventory
--                              data and it stays theirs.
--
--   garment_measurement_stats  the nightly rollup that public pages read.
--                              DENY-ALL, service-role only, same class as
--                              brand_size_charts. Aggregate, no owner column,
--                              no way to attribute a number to one seller.
--
-- Design: docs/superpowers/specs/2026-08-31-fit-measurement-index-design.md
--
-- ⚠ NO REVOKE ANYWHERE IN THIS FILE, and that is deliberate — copied forward
-- from 00609 and 00708. On this Postgres image supautils decorates a
-- permission-denied error with a GRANT hint, and building that hint SEGFAULTS
-- the backend on a FUNCTION denial, restarting every other session with it
-- (US-2403, still open; 00527 is parked as a DO NOT APPLY for the same
-- reason). Authorization here comes from the TABLE, never from EXECUTE:
-- deny-all RLS takes the ordinary 42501 path and nothing builds a hint.

-- ── garment_measurements: the observations ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.garment_measurements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id            uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,

  -- Identity. style_key and department are NOT NULL DEFAULT '' rather than
  -- nullable for the reason 00389 gives about brand_styles: PostgREST upsert
  -- onConflict cannot target an expression index, so the natural key has to be
  -- plain columns. An observation whose style did not resolve still counts —
  -- it rolls up to a brand-level cohort, which is a weaker page but a real one.
  brand_key          text NOT NULL,
  style_key          text NOT NULL DEFAULT '',
  department         text NOT NULL DEFAULT '',

  measurement_group  text NOT NULL,   -- a MeasurementGroup: top | bottom | ...
  size_label         text NOT NULL,   -- normalizeSizeLabel() output
  size_system        text,

  field_key          text NOT NULL,   -- a MeasurementField.key: chest | inseam | ...
  inches             numeric(5,2) NOT NULL CHECK (inches > 0),

  -- 'measurecard' = calibrated extraction off the card plane (US-1572), the
  -- highest-quality source available anywhere. 'listing_text' = parsed out of
  -- the seller's own synced listing description, at a lower fixed confidence.
  -- Recorded per row so a parser defect is undone by deleting one source
  -- rather than by rebuilding the whole corpus.
  source             text NOT NULL CHECK (source IN ('measurecard', 'listing_text')),
  confidence         numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One garment counts ONCE per field. Re-measuring updates the row.
CREATE UNIQUE INDEX IF NOT EXISTS garment_measurements_item_field_idx
  ON public.garment_measurements (item_id, field_key);

-- The aggregate job's read path: every observation in one cohort.
CREATE INDEX IF NOT EXISTS garment_measurements_cohort_idx
  ON public.garment_measurements
  (brand_key, style_key, department, measurement_group, size_label, field_key);

-- The opt-out delete path, and the tenant read.
CREATE INDEX IF NOT EXISTS garment_measurements_user_idx
  ON public.garment_measurements (user_id);

ALTER TABLE public.garment_measurements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own garment measurements"
  ON public.garment_measurements;
CREATE POLICY "Users read own garment measurements"
  ON public.garment_measurements FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users insert own garment measurements"
  ON public.garment_measurements;
CREATE POLICY "Users insert own garment measurements"
  ON public.garment_measurements FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users update own garment measurements"
  ON public.garment_measurements;
CREATE POLICY "Users update own garment measurements"
  ON public.garment_measurements FOR UPDATE
  USING ((select auth.uid()) = user_id);

-- DELETE is a policy and not an oversight: the opt-out in US-3038 removes a
-- seller's contributions, and a user must be able to do that themselves.
DROP POLICY IF EXISTS "Users delete own garment measurements"
  ON public.garment_measurements;
CREATE POLICY "Users delete own garment measurements"
  ON public.garment_measurements FOR DELETE
  USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS set_garment_measurements_updated_at
  ON public.garment_measurements;
CREATE TRIGGER set_garment_measurements_updated_at
  BEFORE UPDATE ON public.garment_measurements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── garment_measurement_stats: the published aggregate ──────────────────────
--
-- AGGREGATE ONLY. No owner column and no contributor identity, so a row cannot
-- say whose garments are behind a number. contributor_count is a COUNT of
-- distinct contributors and nothing more; it exists to enforce a privacy floor,
-- not to identify anybody.
--
-- Insufficient cohorts are still WRITTEN, with sufficient=false, following the
-- jobs-durability-aggregate.ts precedent: the read path filters rather than the
-- write path hiding. That is what keeps coverage measurable, which is exactly
-- what the US-3037 gate has to answer before any public page is written.

CREATE TABLE IF NOT EXISTS public.garment_measurement_stats (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  brand_key          text NOT NULL,
  style_key          text NOT NULL DEFAULT '',
  department         text NOT NULL DEFAULT '',
  measurement_group  text NOT NULL,
  size_label         text NOT NULL,
  field_key          text NOT NULL,

  sample_count       integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  contributor_count  integer NOT NULL DEFAULT 0 CHECK (contributor_count >= 0),

  p25                numeric(5,2),
  median             numeric(5,2),
  p75                numeric(5,2),

  -- Both floors cleared: MIN_MEASUREMENT_SAMPLE garments from
  -- MIN_MEASUREMENT_CONTRIBUTORS distinct contributors. Computed by the job and
  -- stored, so the page and the sitemap read one answer instead of two.
  sufficient         boolean NOT NULL DEFAULT false,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The natural key. Plain columns so PostgREST upsert onConflict can target it.
CREATE UNIQUE INDEX IF NOT EXISTS garment_measurement_stats_key_idx
  ON public.garment_measurement_stats
  (brand_key, style_key, department, measurement_group, size_label, field_key);

-- The public page read: everything publishable for one brand or one style.
CREATE INDEX IF NOT EXISTS garment_measurement_stats_published_idx
  ON public.garment_measurement_stats (brand_key, style_key)
  WHERE sufficient;

ALTER TABLE public.garment_measurement_stats ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: global reference data with no tenant to scope by,
-- the same class and the same reasoning as brand_size_charts. Registered in
-- SERVICE_ROLE_ONLY in rls-guard_test.ts.

DROP TRIGGER IF EXISTS set_garment_measurement_stats_updated_at
  ON public.garment_measurement_stats;
CREATE TRIGGER set_garment_measurement_stats_updated_at
  BEFORE UPDATE ON public.garment_measurement_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00709') on conflict do nothing;
