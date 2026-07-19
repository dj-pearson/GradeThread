-- US-2140: give an authenticity human review somewhere to land.
--
-- authenticity_needs_review already routes correctly (a red_flags verdict, or a
-- branded assessment under 0.7 confidence), but human_reviews is condition-
-- shaped — original_score/adjusted_score decimals — so a reviewer has no field
-- to record an authenticity outcome in. The review is requested and then cannot
-- be resolved.
--
-- A separate table rather than columns on human_reviews: the two outcomes share
-- no vocabulary (a grade correction is a number, an authenticity outcome is a
-- verdict plus the tells it rested on), and keeping them apart is what lets the
-- admin queue show them distinctly.
--
-- The golden-set link is the point. A resolved authenticity review is expert-
-- labelled ground truth about a real submission, which is the cheapest ongoing
-- source of the cases US-2131 otherwise has to source by hand.

CREATE TABLE IF NOT EXISTS public.authenticity_review_outcomes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_report_id     uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  -- Optional: the condition review resolved in the same sitting, when there was
  -- one. Authenticity routes to review on its own axis, so this is often null.
  human_review_id     uuid REFERENCES public.human_reviews(id) ON DELETE SET NULL,
  reviewer_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- What the pass said, snapshotted at review time. Stored rather than joined:
  -- a later re-assessment must not rewrite what the reviewer was looking at.
  model_verdict       text,
  model_confidence    numeric(4,3),
  model_prompt_version text,

  -- The expert's ground truth, in the golden-set vocabulary so a promoted case
  -- needs no translation.
  reviewer_verdict    text NOT NULL
    CHECK (reviewer_verdict IN ('authentic', 'counterfeit', 'inconclusive')),
  -- Which tells the reviewer actually relied on, e.g. {date_code, stitching}.
  tells_relied_on     text[] NOT NULL DEFAULT '{}',
  reasoning           text,

  -- Loop back into the golden set (US-2131). Null until an operator promotes it.
  golden_case_id      uuid REFERENCES public.authenticity_eval_cases(id) ON DELETE SET NULL,

  reviewed_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One authenticity outcome per grade report: a re-review corrects the row
-- rather than stacking a second verdict the queue would have to disambiguate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_authenticity_review_outcomes_report
  ON public.authenticity_review_outcomes(grade_report_id);
-- The queue's working set: resolved reviews not yet promoted to the golden set.
CREATE INDEX IF NOT EXISTS idx_authenticity_review_outcomes_unpromoted
  ON public.authenticity_review_outcomes(reviewed_at)
  WHERE golden_case_id IS NULL;

DROP TRIGGER IF EXISTS set_authenticity_review_outcomes_updated_at
  ON public.authenticity_review_outcomes;
CREATE TRIGGER set_authenticity_review_outcomes_updated_at
  BEFORE UPDATE ON public.authenticity_review_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: admin-only, matching the eval tables in 00405. Operator reference data —
-- no seller route reads it, and the verdict it carries about someone's item is
-- exactly the kind of thing the subject should not be able to influence.
ALTER TABLE public.authenticity_review_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage authenticity review outcomes"
  ON public.authenticity_review_outcomes;
CREATE POLICY "Admins manage authenticity review outcomes"
  ON public.authenticity_review_outcomes FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00487') on conflict do nothing;
