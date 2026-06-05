-- US-504: DB CHECK constraints for fixed-value columns + an integrity scan.
--
-- repricing_suggestions.status and .reason_code (00059) were free-text — an app
-- bug could persist an out-of-domain value that then silently vanishes from the
-- status/reason filters. Constrain them to their documented domains. Added NOT
-- VALID then VALIDATE so the migration both protects new rows AND verifies the
-- existing data (a VALIDATE failure on deploy is the intended signal that bad
-- rows already exist and need cleanup).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repricing_suggestions_status_chk'
  ) THEN
    ALTER TABLE public.repricing_suggestions
      ADD CONSTRAINT repricing_suggestions_status_chk
      CHECK (status IN ('pending', 'applied', 'dismissed')) NOT VALID;
    ALTER TABLE public.repricing_suggestions
      VALIDATE CONSTRAINT repricing_suggestions_status_chk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repricing_suggestions_reason_chk'
  ) THEN
    ALTER TABLE public.repricing_suggestions
      ADD CONSTRAINT repricing_suggestions_reason_chk
      CHECK (reason_code IN ('UNDERPRICED', 'OVERPRICED', 'STALE', 'OK', 'NO_COMPS')) NOT VALID;
    ALTER TABLE public.repricing_suggestions
      VALIDATE CONSTRAINT repricing_suggestions_reason_chk;
  END IF;
END $$;

-- FK ON DELETE audit (AC#2): repricing_suggestions' three FKs (user_id,
-- inventory_item_id, listing_id) are all ON DELETE CASCADE (00059), so a deleted
-- parent can't leave an orphan. The unique index on (listing_id) enforces one
-- current suggestion per listing. email_deliveries / job_locks / feature_flags
-- (00094-00096) are service-role bookkeeping with no tenant FK orphan risk.

-- Periodic integrity scan (AC#3): returns a row per anomaly class with a count,
-- so a cron can alert when anything is non-zero. Kept as a function (not a view)
-- so it's a single round-trip and easy to extend.
CREATE OR REPLACE FUNCTION public.data_integrity_scan()
RETURNS TABLE(anomaly text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- repricing_suggestions whose denormalized user_id drifted from the item's
  -- real owner (the CHECK constraints already prevent invalid status/reason).
  SELECT 'repricing_user_id_drift'::text, count(*)::bigint
  FROM public.repricing_suggestions rs
  JOIN public.inventory_items ii ON ii.id = rs.inventory_item_id
  WHERE rs.user_id <> ii.user_id
  UNION ALL
  -- email outbox stuck pending far past its last scheduled attempt (the retry
  -- cron should have moved it to sent/dead_letter).
  SELECT 'email_deliveries_stuck_pending'::text, count(*)::bigint
  FROM public.email_deliveries
  WHERE status = 'pending' AND next_attempt_at < now() - interval '6 hours'
  UNION ALL
  -- submissions stranded in 'processing' beyond the stuck-recovery window
  -- (the US-495 sweep should have failed+refunded them).
  SELECT 'submissions_stuck_processing'::text, count(*)::bigint
  FROM public.submissions
  WHERE status = 'processing' AND updated_at < now() - interval '1 hour';
$$;

COMMENT ON FUNCTION public.data_integrity_scan() IS
  'US-504: returns anomaly classes with counts; a cron alerts when any count > 0.';

REVOKE ALL ON FUNCTION public.data_integrity_scan() FROM anon, authenticated;
