-- Publish-to-transparency flag for reliability studies (US-866).
--
-- US-334 introduced blind multi-rater reliability studies and the public
-- transparency report (US-326) auto-cited the most recent CLOSED study with a
-- sufficient sample. US-866 makes publication an explicit, admin-controlled act:
-- a closed study's human-vs-human baseline (Krippendorff's alpha, human MAE,
-- AI-vs-human agreement) only appears on the public /transparency page once an
-- admin marks it "published to transparency". Until then the page shows a clean
-- "baseline pending" state rather than a study the team hasn't vetted.

ALTER TABLE public.reliability_studies
  ADD COLUMN IF NOT EXISTS published_to_transparency boolean NOT NULL DEFAULT false;

-- The public transparency loader scans published, closed studies newest-first.
CREATE INDEX IF NOT EXISTS idx_reliability_studies_published
  ON public.reliability_studies(created_at DESC)
  WHERE published_to_transparency AND status = 'closed';
