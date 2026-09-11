-- US-3326: a finished grade waits for the turnaround the customer paid for.
--
-- Express is promised in 1 hour, Premium in 12, Standard in 48 (TIER_SLA_HOURS,
-- editable in pricing_config). A grade that auto-approves goes live in
-- minutes whatever tier was bought, so paying for speed buys nothing a customer
-- can see. With the hold on, a non-Express grade is released at paid time plus
-- its tier's hours.
--
-- NOTHING CHANGES UNTIL AN OPERATOR TURNS IT ON. release_at is written only
-- when system_settings.grade_release_hold.enabled is true and the tier is not
-- Express; every other grade keeps release_at NULL, and every predicate below
-- treats NULL as "not held". The setting is seeded OFF.
--
-- THE MECHANISM, in three parts:
--   1. release_at: when the grade may be seen by its owner. The owner and
--      workspace SELECT policies hide the row until then, so the SPA and both
--      apps, which read grade_reports directly, cannot show the score early.
--   2. review_status 'held': a reviewer (or auto-approve) has decided, but
--      release_at has not come. Not 'approved'/'modified', so the public
--      certificate view, the condition index and the leaderboards (all gated on
--      those two values) keep excluding it; not 'pending', so the review queue
--      stops showing it. held_modified remembers approve-vs-adjust for the
--      release.
--   3. release_notified_at: exactly-once marker for the notice a seller gets
--      when a still-in-review grade becomes visible at release_at.
-- The release itself is /api/jobs/grade-release (every 5 minutes).

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS release_at          timestamptz,
  ADD COLUMN IF NOT EXISTS held_modified       boolean,
  ADD COLUMN IF NOT EXISTS release_notified_at timestamptz;

-- review_status gains 'held'. 00312 added the CHECK inline, so its name is
-- Postgres-generated; drop whichever check mentions review_status and add a
-- named one. Safe to run twice.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.grade_reports'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%review_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.grade_reports DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.grade_reports
    ADD CONSTRAINT grade_reports_review_status_check
    CHECK (review_status IN ('pending', 'approved', 'modified', 'held'));
END $$;

-- The release cron reads only rows that are waiting.
CREATE INDEX IF NOT EXISTS idx_grade_reports_release_due
  ON public.grade_reports (release_at)
  WHERE release_at IS NOT NULL AND finalized_at IS NULL;

-- Owner and workspace reads: unchanged except that a held grade stays hidden
-- until release_at. Same shape as 00451 (initplan-cached auth.uid()).
DROP POLICY IF EXISTS "Users can view own grade reports" ON public.grade_reports;
CREATE POLICY "Users can view own grade reports"
  ON public.grade_reports FOR SELECT
  USING (
    (grade_reports.release_at IS NULL OR grade_reports.release_at <= now())
    AND EXISTS (
      SELECT 1 FROM public.submissions
      WHERE submissions.id = grade_reports.submission_id
        AND submissions.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Workspace members can view grade reports" ON public.grade_reports;
CREATE POLICY "Workspace members can view grade reports"
  ON public.grade_reports FOR SELECT
  USING (
    (grade_reports.release_at IS NULL OR grade_reports.release_at <= now())
    AND EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = grade_reports.submission_id
        AND ((select auth.uid()) = s.user_id OR public.is_workspace_member(s.user_id))
    )
  );

INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'grade_release_hold',
  '{"enabled": false}'::jsonb, 'json', '{"enabled": false}'::jsonb, 'grading',
  'US-3326: when enabled, a finished non-Express grade is released to its owner at paid time plus the tier turnaround hours (pricing config), not the moment it is final. Turning it off releases every held grade on the next /api/jobs/grade-release run.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00786') on conflict do nothing;
