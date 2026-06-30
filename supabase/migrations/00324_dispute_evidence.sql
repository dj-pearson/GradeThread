-- US-1416: persist the evidence photos a user attaches when filing a grade
-- dispute. The dispute dialog uploaded photos to the submission-images bucket
-- but the disputes row only stored `reason`, so the uploads were orphaned and
-- never reachable by whoever reviews the dispute. Store the storage paths on the
-- dispute so the admin review UI can sign + display them.
--
-- Idempotent (US-1108): ADD COLUMN IF NOT EXISTS, safe to re-run.

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS evidence_paths text[] NOT NULL DEFAULT '{}';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00324') ON CONFLICT DO NOTHING;
