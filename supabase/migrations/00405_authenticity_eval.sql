-- US-1770: authenticity golden-set eval gate + human-review routing.
--
-- Mirrors the grading self-improvement eval tables (00050 grading_eval_cases /
-- grading_eval_runs) for the BRAND-authenticity add-on (US-601/US-1769). A
-- candidate authenticity prompt version must clear an accuracy gate against a
-- labeled authentic-vs-counterfeit golden set BEFORE it activates for real
-- users — so we never ship a confident-but-wrong authenticity verdict.
--
-- Both tables are GLOBAL REFERENCE / operator data (no tenant): admin-only RLS,
-- same as grading_eval_*. The golden set grows from REAL labeled examples an
-- operator curates (authentic vs counterfeit per top brand) — never fabricated,
-- exactly like the grading golden set.

-- ── authenticity_eval_cases: the labeled golden set ─────────────────────────
CREATE TABLE IF NOT EXISTS public.authenticity_eval_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-readable label, e.g. "Gucci Marmont, boutique, genuine".
  label             text NOT NULL,
  -- Canonical brand key (joins brand_knowledge.brand_key) the case authenticates.
  brand_key         text NOT NULL,
  -- Display brand (as a lister would supply it), replayed as the claimed brand.
  brand             text,
  -- Optional garment context for the replay (nullable — authenticity is
  -- brand-centric and covers accessories outside the garment_type enum).
  garment_type      public.garment_type,
  -- Case photos in the submission-images bucket: [{image_type, storage_path}].
  images            jsonb NOT NULL DEFAULT '[]',
  -- Ground truth from an expert: is this a genuine or counterfeit example?
  -- 'inconclusive' covers deliberately-ambiguous cases (no recognizable brand).
  expected_label    text NOT NULL CHECK (expected_label IN ('authentic', 'counterfeit', 'inconclusive')),
  -- Free-form tags for slicing eval results, e.g. {hardware, date_code}.
  tags              text[] NOT NULL DEFAULT '{}',
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  source_url        text,
  created_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_authenticity_eval_cases_active
  ON public.authenticity_eval_cases(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_authenticity_eval_cases_brand
  ON public.authenticity_eval_cases(brand_key);

DROP TRIGGER IF EXISTS set_authenticity_eval_cases_updated_at ON public.authenticity_eval_cases;
CREATE TRIGGER set_authenticity_eval_cases_updated_at
  BEFORE UPDATE ON public.authenticity_eval_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── authenticity_eval_runs: result of a candidate prompt vs the golden set ───
CREATE TABLE IF NOT EXISTS public.authenticity_eval_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The authenticity prompt version under test (e.g. 'authenticity_v1+tells').
  prompt_version    text NOT NULL,
  model             text NOT NULL,
  cases_total       integer NOT NULL,
  cases_agreed      integer NOT NULL,
  -- Fraction of cases whose derived verdict class matched the expected label.
  agreement_rate    numeric(5,4) NOT NULL,
  -- Did the run clear the activation threshold?
  passed            boolean NOT NULL,
  -- Per-case results + per-brand accuracy breakdown for inspection (AC3).
  per_case          jsonb NOT NULL DEFAULT '[]',
  per_brand         jsonb NOT NULL DEFAULT '{}',
  triggered_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_authenticity_eval_runs_version
  ON public.authenticity_eval_runs(prompt_version);
CREATE INDEX IF NOT EXISTS idx_authenticity_eval_runs_created_at
  ON public.authenticity_eval_runs(created_at DESC);

-- ── RLS: admin-only for both tables (operator/global reference) ─────────────
ALTER TABLE public.authenticity_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authenticity_eval_runs  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage authenticity eval cases" ON public.authenticity_eval_cases;
CREATE POLICY "Admins manage authenticity eval cases"
  ON public.authenticity_eval_cases FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage authenticity eval runs" ON public.authenticity_eval_runs;
CREATE POLICY "Admins manage authenticity eval runs"
  ON public.authenticity_eval_runs FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00405') on conflict do nothing;
