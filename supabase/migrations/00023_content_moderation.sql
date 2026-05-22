-- Content moderation: submissions whose AI analysis suggests the images are
-- not actually clothing get flagged for admin review, and abusive users can
-- be suspended to block further submissions.

ALTER TABLE public.submissions
  ADD COLUMN flagged boolean NOT NULL DEFAULT false,
  ADD COLUMN flag_reason text,
  ADD COLUMN moderation_status text
    CHECK (moderation_status IN ('approved', 'rejected'));

CREATE INDEX idx_submissions_flagged
  ON public.submissions (flagged)
  WHERE flagged AND moderation_status IS NULL;

ALTER TABLE public.users
  ADD COLUMN suspended boolean NOT NULL DEFAULT false;
