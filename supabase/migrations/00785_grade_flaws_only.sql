-- US-3325: store the grade the structured flaws ALONE would give, beside the
-- real grade, so accuracy tracking can say which one lands closer to a human.
--
-- defect-weighting.ts derives a per-factor ceiling from the flaw list (10 minus
-- the routed penalties) and compositeGrade keeps min(model, ceiling). The
-- ceiling-only grade was computed on every grade and discarded. Nothing reads
-- this table to grade: overall_score and the five factor columns are unchanged.
--
-- WHY A SEPARATE TABLE AND NOT TWO COLUMNS ON grade_reports: the owner of a
-- grade can read their own grade_reports row through RLS. Next to the
-- published factor routing and severity multipliers, a per-factor flaws-only
-- ceiling reveals the per-defect penalty (BASE_WEIGHT), which is deliberately
-- unpublished because a seller who knows the arithmetic photographs to
-- minimise it (defect-weighting.ts, US-2107). So this is deny-all: RLS on, no
-- policies, service role only.
--
-- One row per grade made after this migration; readers exclude older grades
-- and report how many they excluded.

CREATE TABLE IF NOT EXISTS public.grade_flaws_only (
  grade_report_id uuid PRIMARY KEY
    REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  overall numeric(3,1) NOT NULL
    CHECK (overall >= 1.0 AND overall <= 10.0),
  -- The five flaws-only factor ceilings, keyed like the grade_reports factor
  -- columns (fabric_condition_score, ...).
  factors jsonb NOT NULL,
  weights_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.grade_flaws_only ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: anon and authenticated read nothing.

DROP TRIGGER IF EXISTS set_grade_flaws_only_updated_at ON public.grade_flaws_only;
CREATE TRIGGER set_grade_flaws_only_updated_at
  BEFORE UPDATE ON public.grade_flaws_only
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.grade_flaws_only IS
  'US-3325: the grade the flaw list alone would give, for accuracy comparison. '
  'Deny-all: it would reveal the unpublished per-defect penalties.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00785') on conflict do nothing;
