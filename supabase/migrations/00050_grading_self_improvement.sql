-- Grading self-improvement + intentional-design handling (US-070/US-073 refinement).
--
-- Three problems this migration unblocks:
--
-- 1. INTENTIONAL DESIGN vs DEFECT. The grader had no concept of factory
--    distressing — a pristine ripped/whiskered/acid-wash jean was scored as
--    "Poor" because rips/raw hems map onto Fabric (30%) + Structural (25%) =
--    55% of the grade. We now (a) let sellers declare design features as a
--    hint and (b) persist what the AI judged to be intentional so it never
--    silently double-counts a design feature as damage.
--
-- 2. DEAD SELF-IMPROVEMENT LOOP. ai_prompt_versions held prompt_text +
--    accuracy_score but the runtime never read it, and the accuracy join
--    keyed on the full "model|version" string which never matched a
--    version_name. We add a first-class prompt_version column on
--    grade_reports + stage/scope on ai_prompt_versions + per-factor human
--    corrections so accuracy can actually be attributed and written back.
--
-- 3. NO EVAL GATE. We add a golden eval-case set + eval-run results so a new
--    prompt version is scored against known-answer garments (incl. distressed
--    denim) BEFORE it's allowed to go active.

-- ════════════════════════════════════════════════════════════════════
-- 1. SELLER-DECLARED DESIGN FEATURES (hint into the grader)
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS style_attributes text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.submissions.style_attributes IS
  'Optional seller-declared intentional design features (e.g. distressed, '
  'ripped, raw-hem, acid-wash, cropped, tie-dye). Passed to the grader as a '
  'HINT that observed "damage" may be by design — the AI still verifies '
  'visually and may override.';

-- ════════════════════════════════════════════════════════════════════
-- 2. GRADE REPORT: persist design findings, per-image trace, prompt version
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.grade_reports
  -- What the AI concluded are intentional design features (array of
  -- { attribute, location, confidence }). Surfaced on the certificate so a
  -- buyer sees distressing was assessed, not missed.
  ADD COLUMN IF NOT EXISTS detected_style_attributes jsonb NOT NULL DEFAULT '[]',
  -- Raw per-image analysis trace. Kept for eval/training and for explaining a
  -- grade during dispute review. Nullable — historical rows won't have it.
  ADD COLUMN IF NOT EXISTS per_image_analysis jsonb,
  -- First-class prompt version (e.g. "composite_v2"). model_version still
  -- stores the combined "model|prompt" string for back-compat, but the
  -- accuracy loop now groups on this column.
  ADD COLUMN IF NOT EXISTS prompt_version text;

COMMENT ON COLUMN public.grade_reports.detected_style_attributes IS
  'AI-judged intentional design features (distressing, raw hems, etc.). These '
  'do NOT lower the grade — condition is measured relative to as-manufactured '
  'state.';
COMMENT ON COLUMN public.grade_reports.prompt_version IS
  'Prompt version that produced this grade (joins ai_prompt_versions.version_name). '
  'Drives per-version accuracy tracking.';

-- Backfill prompt_version from the existing combined model_version
-- ("model|prompt") so historical accuracy grouping isn't all-NULL.
UPDATE public.grade_reports
  SET prompt_version = split_part(model_version, '|', 2)
  WHERE prompt_version IS NULL
    AND position('|' IN model_version) > 0;

CREATE INDEX IF NOT EXISTS idx_grade_reports_prompt_version
  ON public.grade_reports(prompt_version);

-- ════════════════════════════════════════════════════════════════════
-- 3. HUMAN REVIEWS: per-factor corrections + intentional-misread flag
-- ════════════════════════════════════════════════════════════════════
-- The old loop only captured one overall adjusted_score, then *estimated*
-- per-factor error by scaling the overall ratio — statistically meaningless.
-- Capturing the factor a reviewer actually changed lets us find that (e.g.)
-- Fabric Condition is systematically too harsh on distressed denim.

ALTER TABLE public.human_reviews
  ADD COLUMN IF NOT EXISTS adjusted_fabric_condition     numeric(3,1),
  ADD COLUMN IF NOT EXISTS adjusted_structural_integrity numeric(3,1),
  ADD COLUMN IF NOT EXISTS adjusted_cosmetic_appearance  numeric(3,1),
  ADD COLUMN IF NOT EXISTS adjusted_functional_elements  numeric(3,1),
  ADD COLUMN IF NOT EXISTS adjusted_odor_cleanliness     numeric(3,1),
  -- The denim signal: reviewer marks "AI penalized an intentional design
  -- feature as damage." A rising rate here flags a prompt regression.
  ADD COLUMN IF NOT EXISTS intentional_misread boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.human_reviews.intentional_misread IS
  'Reviewer flag: the AI treated an intentional design feature (e.g. factory '
  'distressing) as a condition defect. Tracked per garment_category to detect '
  'prompt regressions.';

-- ════════════════════════════════════════════════════════════════════
-- 4. AI PROMPT VERSIONS: stage + scope + DB-driven overrides
-- ════════════════════════════════════════════════════════════════════
-- Prompts live in code as versioned defaults; an active row here OVERRIDES
-- the code prompt for a stage, enabling no-deploy iteration + A/B testing.

ALTER TABLE public.ai_prompt_versions
  -- Which grading stage this prompt drives.
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'composite'
    CHECK (stage IN ('per_image', 'composite')),
  -- NULL = applies to all garments; otherwise a garment_category slug to
  -- scope a specialized prompt (e.g. a denim-tuned composite prompt).
  ADD COLUMN IF NOT EXISTS garment_scope text,
  -- Did this version clear the eval gate? Activation is blocked until true.
  ADD COLUMN IF NOT EXISTS eval_passed boolean,
  ADD COLUMN IF NOT EXISTS eval_run_id uuid,
  ADD COLUMN IF NOT EXISTS notes text;

-- Only one ACTIVE prompt per (stage, scope). Partial unique index treats
-- NULL scope as the global default slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompt_versions_active_stage_scope
  ON public.ai_prompt_versions(stage, COALESCE(garment_scope, ''))
  WHERE is_active = true;

-- Seed rows mirroring the in-code default versions so the accuracy join +
-- accuracy_score write-back have a target. prompt_text empty = "use code
-- default"; the runtime falls back to the constant when no active override.
INSERT INTO public.ai_prompt_versions (version_name, prompt_text, stage, is_active, notes)
VALUES
  ('per_image_v2',  '', 'per_image', false,
   'In-code default (analyzeImage). Seeded so accuracy tracking can attribute grades.'),
  ('composite_v2',  '', 'composite', false,
   'In-code default (compositeGrade). Seeded so accuracy tracking can attribute grades.')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- 5. EVAL HARNESS: golden cases + run results (the activation gate)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.grading_eval_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-readable label, e.g. "Levi's 501 factory-distressed, NWOT".
  label             text NOT NULL,
  garment_type      public.garment_type NOT NULL,
  garment_category  public.garment_category NOT NULL,
  brand             text,
  description       text,
  -- Seller-style hint to replay through the grader, same shape as
  -- submissions.style_attributes.
  style_attributes  text[] NOT NULL DEFAULT '{}',
  -- Storage paths (submission-images bucket) of the case photos, with their
  -- image_type, e.g. [{ "image_type": "front", "storage_path": "eval/.../front.jpg" }].
  images            jsonb NOT NULL DEFAULT '[]',
  -- Ground truth from an expert grader.
  expected_score    numeric(3,1) NOT NULL CHECK (expected_score >= 1.0 AND expected_score <= 10.0),
  expected_tier     public.grade_tier NOT NULL,
  -- Free-form tags for slicing eval results, e.g. {distressed_denim, raw_hem}.
  tags              text[] NOT NULL DEFAULT '{}',
  -- Disable a case without deleting it.
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grading_eval_cases_active
  ON public.grading_eval_cases(is_active) WHERE is_active = true;

CREATE TRIGGER set_grading_eval_cases_updated_at
  BEFORE UPDATE ON public.grading_eval_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Result of running a candidate prompt version against the active eval set.
CREATE TABLE IF NOT EXISTS public.grading_eval_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_version_id   uuid REFERENCES public.ai_prompt_versions(id) ON DELETE SET NULL,
  prompt_version_name text NOT NULL,
  model               text NOT NULL,
  -- Aggregate metrics across all cases.
  mean_absolute_error numeric(4,2) NOT NULL,
  agreement_rate      numeric(5,4) NOT NULL,  -- fraction within 0.5
  cases_total         integer NOT NULL,
  cases_passed        integer NOT NULL,
  -- Did the run clear the activation thresholds?
  passed              boolean NOT NULL,
  -- Per-case + per-tag breakdown for inspection.
  per_case            jsonb NOT NULL DEFAULT '[]',
  per_tag             jsonb NOT NULL DEFAULT '{}',
  triggered_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grading_eval_runs_version
  ON public.grading_eval_runs(prompt_version_id);
CREATE INDEX IF NOT EXISTS idx_grading_eval_runs_created_at
  ON public.grading_eval_runs(created_at DESC);

-- FK from the prompt version to its passing run (added after the table exists).
-- Guarded so re-running the migration doesn't error (no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_prompt_versions_eval_run'
  ) THEN
    ALTER TABLE public.ai_prompt_versions
      ADD CONSTRAINT fk_ai_prompt_versions_eval_run
        FOREIGN KEY (eval_run_id) REFERENCES public.grading_eval_runs(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── RLS: admin-only for both eval tables ──────────────────────────────
ALTER TABLE public.grading_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grading_eval_runs  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage eval cases"
  ON public.grading_eval_cases FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins read eval runs"
  ON public.grading_eval_runs FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins write eval runs"
  ON public.grading_eval_runs FOR INSERT
  WITH CHECK (public.is_admin());
