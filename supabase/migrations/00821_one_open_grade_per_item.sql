-- US-3214: one open grade per garment, enforced where a race cannot get past it.
--
-- WHAT THIS REFUSES. A second `flipdesk_grading_submissions` row for an
-- inventory item that already has one in a non-terminal state. Before it, a
-- double click on Submit created two submissions, ran Claude twice, and
-- charged twice -- once against credits (which US-2564's batch key already
-- deduped) and once against the monthly included bundle (which it did not:
-- claimIncluded() in grade-billing.ts is a compare-and-swap increment with no
-- idempotency key at all).
--
-- WHY AN INDEX AND NOT A CHECK IN THE CODE. lib/grading-submit.ts now reads
-- the open submissions for the batch before the loop and refuses there too,
-- and that read cannot close the race on its own: two clicks land in two
-- isolates, both read "nothing running", and both charge. The same argument
-- 00819 made for one open work session per seller, and the same answer.
--
-- ⚠ THE INSERT MOVED SO THIS INDEX CAN DO ITS JOB. The link row used to be
-- written AFTER the charge and the photo copy (step 4); it is now step 1b,
-- immediately after the submissions row and before runPaymentPrecedence. The
-- loser of a race takes a 23505 while the money is still untouched, which is
-- the whole point. Deploy order matters: this migration must be applied
-- BEFORE the edge carrying that reorder, or the second press still charges.
--
-- The non-terminal set matches NON_TERMINAL_SUBMISSION_STATES in
-- services/edge-functions/src/lib/grading-submit.ts. `pending_review` is in
-- it because the AI grade exists but is withheld until a human finalises it,
-- so a second submission is a second Claude run against a garment already
-- being graded.

-- ── the backfill, which is the risky half ───────────────────────────────────
-- Rows the defect produced are exactly the rows the index refuses, so a bare
-- CREATE UNIQUE INDEX fails on any database where a seller ever double
-- clicked. The duplicates are closed first: the one to KEEP is the oldest,
-- because that is the submission the pipeline actually ran and the one whose
-- grade the seller will see. The rest are marked `failed` with a reason --
-- nothing is deleted, so the record that they existed (and were charged)
-- survives for the refund US-3214 AC4 offers.
DO $$
DECLARE
  closed integer := 0;
BEGIN
  IF to_regclass('public.flipdesk_grading_submissions') IS NULL THEN
    RETURN;
  END IF;

  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY inventory_item_id
             ORDER BY created_at ASC, id ASC
           ) AS rn
      FROM public.flipdesk_grading_submissions
     WHERE status IN ('pending', 'processing', 'pending_review')
  )
  UPDATE public.flipdesk_grading_submissions f
     SET status = 'failed',
         error = coalesce(f.error, '') ||
                 case when coalesce(f.error, '') = '' then '' else ' | ' end ||
                 'closed by 00821: duplicate open grade for this item (US-3214)',
         updated_at = now()
    FROM ranked r
   WHERE f.id = r.id
     AND r.rn > 1;
  GET DIAGNOSTICS closed = ROW_COUNT;
  IF closed > 0 THEN
    RAISE NOTICE 'closed % duplicate open grading submission(s)', closed;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_grading_submission_one_open_per_item
  ON public.flipdesk_grading_submissions (inventory_item_id)
  WHERE (status IN ('pending', 'processing', 'pending_review'));

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00821') on conflict do nothing;
