-- Inter-rater reliability benchmark — blind multi-rater studies (US-334).
--
-- A reliability study is a named round in which 2+ expert reviewers each grade
-- the SAME sample of submissions independently, without seeing the AI grade or
-- one another's scores (blindness is enforced by the admin API — the rating
-- queue never returns other ratings or the grade_report). From the collected
-- ratings we compute the human-vs-human agreement baseline + Krippendorff's
-- alpha, and compare the AI's agreement with the human consensus against it —
-- the denominator that makes the published accuracy numbers meaningful.

-- The study (a round). tolerance is the "agreement within" band (default 0.5).
CREATE TABLE IF NOT EXISTS public.reliability_studies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'closed')),
  tolerance   numeric(3, 2) NOT NULL DEFAULT 0.5
                CHECK (tolerance > 0 AND tolerance <= 5),
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The sample: which submissions belong to the study.
CREATE TABLE IF NOT EXISTS public.reliability_study_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id      uuid NOT NULL REFERENCES public.reliability_studies(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, submission_id)
);

-- One reviewer's blind rating of one study item. One rating per reviewer per
-- item (a reviewer can update their own until the study closes).
CREATE TABLE IF NOT EXISTS public.reliability_ratings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id                   uuid NOT NULL REFERENCES public.reliability_studies(id) ON DELETE CASCADE,
  submission_id              uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  reviewer_id                uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  overall_score              numeric(3, 1) NOT NULL
                               CHECK (overall_score >= 1.0 AND overall_score <= 10.0),
  fabric_condition_score     numeric(3, 1),
  structural_integrity_score numeric(3, 1),
  cosmetic_appearance_score  numeric(3, 1),
  functional_elements_score  numeric(3, 1),
  odor_cleanliness_score     numeric(3, 1),
  notes                      text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, submission_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_reliability_study_items_study
  ON public.reliability_study_items(study_id);
CREATE INDEX IF NOT EXISTS idx_reliability_ratings_study
  ON public.reliability_ratings(study_id);
CREATE INDEX IF NOT EXISTS idx_reliability_ratings_reviewer
  ON public.reliability_ratings(study_id, reviewer_id);

-- updated_at maintenance (matches the project-wide trigger convention).
CREATE TRIGGER set_reliability_studies_updated_at
  BEFORE UPDATE ON public.reliability_studies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_reliability_ratings_updated_at
  BEFORE UPDATE ON public.reliability_ratings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: admin/reviewer platform tables. Reads gated to admins (the edge service
-- uses the service-role client for writes, bypassing RLS). No anon/user access.
ALTER TABLE public.reliability_studies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reliability_study_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reliability_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view reliability studies"
  ON public.reliability_studies FOR SELECT USING (public.is_admin());
CREATE POLICY "Admins can view reliability study items"
  ON public.reliability_study_items FOR SELECT USING (public.is_admin());
CREATE POLICY "Admins can view reliability ratings"
  ON public.reliability_ratings FOR SELECT USING (public.is_admin());
