-- US-949: one-tap retake on low-confidence (needs_photos) and expired submissions.
--
-- A submission that came back needs_photos (the quality gate abstained, no charge)
-- or expired (checkout never completed) used to be a dead end: the seller had to
-- create a brand-new submission from scratch and the old one was left orphaned in
-- their list, inflating active counts.
--
-- The retake flow now creates a NEW submission that references the prior one and
-- marks the prior one SUPERSEDED (not deleted) so it drops out of active counts
-- but stays as history. This mirrors the grade_reports.superseded_at model
-- (migration 00150) at the submission level.

ALTER TABLE public.submissions
  -- The submission this one was created to replace (the retaken-from row). NULL
  -- for a normal first submission.
  ADD COLUMN IF NOT EXISTS retake_of_submission_id uuid
    REFERENCES public.submissions(id) ON DELETE SET NULL,
  -- Set on the OLD submission once a retake replaces it. superseded_at IS NULL =
  -- still active; a non-null value excludes the row from active counts.
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_submission_id uuid
    REFERENCES public.submissions(id) ON DELETE SET NULL;

-- Active submissions (the common list/count path) are those NOT yet superseded.
-- A partial index keeps that filter cheap — superseded rows are rare tail history.
CREATE INDEX IF NOT EXISTS idx_submissions_active
  ON public.submissions(user_id, created_at DESC)
  WHERE superseded_at IS NULL;

-- Resolve the retake chain for a submission ("show me its replacement").
CREATE INDEX IF NOT EXISTS idx_submissions_retake_of
  ON public.submissions(retake_of_submission_id)
  WHERE retake_of_submission_id IS NOT NULL;
