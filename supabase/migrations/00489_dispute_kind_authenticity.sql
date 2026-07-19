-- US-2145: let a seller contest an AUTHENTICITY verdict, not only a grade.
--
-- The disputes table is already generic at the schema level — grade_report_id,
-- user_id, free-text reason, status, resolution_notes. Only the RESOLUTION path
-- is grade-shaped (it applies corrected factor scores). So this adds a `kind`
-- discriminator rather than standing up a parallel appeals table, which keeps
-- one lifecycle, one admin queue, one set of RLS policies, and one place a user
-- looks for "what happened to my complaint".
--
-- Defaulting to 'grade' makes every existing row correct without a backfill.

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'grade';

DO $$ BEGIN
  ALTER TABLE public.disputes
    ADD CONSTRAINT disputes_kind_check CHECK (kind IN ('grade', 'authenticity'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.disputes.kind IS
  'US-2145: what is being contested. ''grade'' resolves by adjusting factor '
  'scores; ''authenticity'' resolves by withdrawing the verdict and resealing '
  'the certificate. Defaults to ''grade'' so pre-existing rows stay correct.';

-- The seller-appeal queue: open authenticity disputes, oldest first.
CREATE INDEX IF NOT EXISTS idx_disputes_authenticity_open
  ON public.disputes(created_at)
  WHERE kind = 'authenticity' AND status IN ('open', 'under_review');

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00489') on conflict do nothing;
