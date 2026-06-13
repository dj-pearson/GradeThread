-- US-569: make AI grading durable + idempotent (resume across crashes/redeploys).
--
-- BEFORE: the grade run claimed its submission with a SET-ONCE marker
-- (grading_started_at, US-773). That stopped a double-kick from double-billing
-- Claude, but it could never be resumed: once set, a re-claim was impossible, so
-- a container crash/redeploy MID-GRADE stranded the submission in
-- status='processing' forever. The stuck-submission reaper (US-495) could only
-- FAIL + REFUND those orphans — the paying user lost their grade.
--
-- AFTER: the claim becomes a LEASE. A worker leases the row for a bounded window
-- (grading_lease_until); concurrent/duplicate kicks find an active lease and
-- no-op (still exactly one grade run → Claude billed once). If the holder dies,
-- the lease EXPIRES and the reaper re-kicks the pipeline, which re-leases and
-- RESUMES the work. grading_attempts bounds how many times a poison submission
-- (one that crashes the container every run) can be retried before it's failed +
-- refunded for good. Resume is idempotent at the grade_report: a crash AFTER the
-- report was written but BEFORE status flipped to 'completed' finalizes cheaply
-- without re-running (or re-billing) the AI — see claim_grade_lease's
-- active-report guard + finalizeIfAlreadyGraded() in grading-pipeline.ts.
--
-- The submission row IS the durable grading job here (lease + attempts + resume),
-- mirroring the job-row model US-559 uses for bulk publish
-- (listing_publish_jobs: status/attempts drive claim, retry, and resume after a
-- worker restart) — grading was the one paid path the US-407 job family excluded.

-- ── Lease + attempt columns ──────────────────────────────────────
-- The lease expiry. While grading_lease_until > now() a live worker owns the
-- grade; a re-kick no-ops. Once it's in the past (holder crashed) or NULL
-- (legacy / never-leased), the row is re-claimable.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS grading_lease_until timestamptz;

-- How many times grading has been claimed for this submission. Bounds retries of
-- a poison submission: after GRADING_MAX_ATTEMPTS crashed runs the reaper stops
-- resuming and fails + refunds it instead of crash-looping forever.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS grading_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.submissions.grading_lease_until IS
  'US-569: grading lease expiry. A live grade run holds the lease; duplicate '
  'kicks no-op while it is in the future. Expired/NULL → the row is re-claimable '
  'and the stuck-submission reaper resumes it.';
COMMENT ON COLUMN public.submissions.grading_attempts IS
  'US-569: number of grading claims taken for this submission. Bounds resume '
  'retries of a poison submission (failed + refunded after GRADING_MAX_ATTEMPTS).';

-- The reaper scans processing rows whose lease has expired. A partial index on
-- the processing hot set keyed by the lease keeps that scan cheap.
CREATE INDEX IF NOT EXISTS idx_submissions_processing_lease
  ON public.submissions(grading_lease_until)
  WHERE status = 'processing';

-- ── Atomic lease claim ───────────────────────────────────────────
-- One conditional UPDATE, run server-side so now() and the attempt increment are
-- atomic. Postgres serializes the row-level update, so of N concurrent kicks
-- exactly one transitions the row and gets 'claimed'. Returns a status code so
-- the caller can tell a fresh claim from an already-graded row that just needs
-- finalizing, a live lease, an exhausted (poison) row, or a terminal/gone row.
--
--   'claimed'   → the caller now owns the grade run (lease taken, attempts++)
--   'done'      → an active grade_report already exists; finalize idempotently,
--                 do NOT re-grade (recovers a crash between report insert and the
--                 status='completed' flip)
--   'leased'    → a live worker holds an unexpired lease; no-op
--   'exhausted' → attempts hit the cap; the reaper fails + refunds it
--   'gone'      → no such row, or it reached a terminal status; no-op
CREATE OR REPLACE FUNCTION public.claim_grade_lease(
  p_submission_id uuid,
  p_lease_seconds integer,
  p_max_attempts integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed uuid;
  v_status public.submission_status;
  v_attempts integer;
  v_has_active_report boolean;
BEGIN
  UPDATE public.submissions s
  SET status              = 'processing',
      -- Stamp the first-ever start once; resumes keep the original.
      grading_started_at  = COALESCE(s.grading_started_at, now()),
      grading_lease_until = now() + make_interval(secs => p_lease_seconds),
      grading_attempts    = s.grading_attempts + 1
  WHERE s.id = p_submission_id
    AND s.status IN ('pending', 'processing')
    AND (s.grading_lease_until IS NULL OR s.grading_lease_until < now())
    AND s.grading_attempts < p_max_attempts
    -- Never re-grade a submission that already produced an active report. The
    -- finalize path (claim returns 'done') wires up the terminal state instead.
    AND NOT EXISTS (
      SELECT 1 FROM public.grade_reports gr
      WHERE gr.submission_id = s.id AND gr.superseded_at IS NULL
    )
  RETURNING s.id INTO v_claimed;

  IF v_claimed IS NOT NULL THEN
    RETURN 'claimed';
  END IF;

  -- Didn't claim — diagnose why so the caller can finalize / wait / give up.
  SELECT s.status, s.grading_attempts,
         EXISTS (SELECT 1 FROM public.grade_reports gr
                 WHERE gr.submission_id = s.id AND gr.superseded_at IS NULL)
    INTO v_status, v_attempts, v_has_active_report
  FROM public.submissions s
  WHERE s.id = p_submission_id;

  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  IF v_has_active_report THEN
    RETURN 'done';
  END IF;
  IF v_status NOT IN ('pending', 'processing') THEN
    RETURN 'gone';
  END IF;
  IF v_attempts >= p_max_attempts THEN
    RETURN 'exhausted';
  END IF;
  RETURN 'leased';
END;
$$;

COMMENT ON FUNCTION public.claim_grade_lease(uuid, integer, integer) IS
  'US-569: atomically lease a submission for a grade run. Returns claimed | done '
  '| leased | exhausted | gone. See grading-pipeline.ts.';
