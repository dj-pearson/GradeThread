-- US-2563: Idempotency-Key replay records for the public API.
--
-- THE GAP THIS CLOSES, AND WHY THE EXISTING KEYS DO NOT ALREADY CLOSE IT.
-- Every charging path already passes a derived idempotency key to
-- debit_grade_credits: routes/grade.ts passes `grade_pay:<submissionId>`
-- (US-2298) and lib/grading-batch-worker.ts passes `grade-batch-job:<jobId>`
-- (US-2289). Those are correct for what they guard — one debit per submission,
-- one debit per job — and they are structurally incapable of catching an HTTP
-- retry, because by the time either key exists the retry has already created a
-- SECOND submission (or a second batch of N jobs) to derive its key from.
--
-- The unit that has to be deduplicated is the REQUEST. Nothing in the service
-- models one, so POST /api/v1/grades retried after a load-balancer timeout is
-- two grades and two charges for one garment, and POST /api/v1/grades/batch
-- retried is N of them.
--
-- The contract is Stripe's, deliberately, so no integrator has to learn a new
-- one: same key + same body = replay the stored response; same key + different
-- body = 422; key still in flight = 409 + Retry-After.
--
-- DENY-ALL BY DESIGN. No policies below, so anon and authenticated cannot read
-- or write this table at all; the middleware reaches it through the service-role
-- client. The owner column is named owner_user_id per the rls-guard convention,
-- and the table is registered in SERVICE_ROLE_ONLY in rls-guard_test.ts.

CREATE TABLE IF NOT EXISTS public.api_idempotency_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The calling key, for operator forensics. Not part of the identity: a client
  -- that rotates keys mid-retry is still retrying the same request.
  api_key_id           uuid,
  -- METHOD + path. Part of the identity so one key used on a create and then on
  -- a later read is two records rather than a spurious conflict.
  endpoint             text NOT NULL,
  idempotency_key      text NOT NULL,
  -- SHA-256 of the raw request body. Catches the client that recycles a key
  -- across two genuinely different garments — without it, the second garment
  -- would silently receive the FIRST garment's grade, which is a worse failure
  -- than the double charge this table exists to prevent.
  request_fingerprint  text NOT NULL,
  state                text NOT NULL DEFAULT 'in_progress'
                       CHECK (state IN ('in_progress', 'completed')),
  response_status      integer,
  response_body        jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);

-- THE ARBITER. The middleware claims by INSERT and reads the existing row on a
-- 23505, rather than SELECT-then-INSERT: two concurrent retries must not both
-- conclude they are the first, and only a unique index can decide that.
CREATE UNIQUE INDEX IF NOT EXISTS api_idempotency_records_key_idx
  ON public.api_idempotency_records (owner_user_id, endpoint, idempotency_key);

-- The pruning sweep's index.
CREATE INDEX IF NOT EXISTS api_idempotency_records_created_idx
  ON public.api_idempotency_records (created_at);

COMMENT ON TABLE public.api_idempotency_records IS
  'US-2563: Idempotency-Key replay records for /api/v1/*. Rows are pruned after '
  '24h by prune_api_idempotency_records(); a client retrying beyond that window '
  'should be reconciling by polling GET /grades, not resubmitting.';
COMMENT ON COLUMN public.api_idempotency_records.request_fingerprint IS
  'SHA-256 hex of the raw request body. A mismatch against a stored key is a '
  '422, not a replay.';
COMMENT ON COLUMN public.api_idempotency_records.state IS
  'in_progress = claimed, handler running. completed = response stored and '
  'replayable. A failed handler DELETES its claim so the retry is a real '
  'attempt rather than a 409 against a request that produced nothing.';

ALTER TABLE public.api_idempotency_records ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all for anon and authenticated. Service-role only.

-- ── Pruning ───────────────────────────────────────────────────────────────
--
-- Unbounded growth on a table written once per mutating API call is a slow leak,
-- and the retention window is a product decision rather than a storage one: 24h
-- is longer than any sane client retry budget and short enough that the table
-- stays small. Called by the maintenance cron.
CREATE OR REPLACE FUNCTION public.prune_api_idempotency_records(
  p_older_than interval DEFAULT interval '24 hours'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'prune_api_idempotency_records is service-role only';
  END IF;

  DELETE FROM public.api_idempotency_records
   WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_api_idempotency_records(interval) FROM public;
REVOKE ALL ON FUNCTION public.prune_api_idempotency_records(interval) FROM anon;
REVOKE ALL ON FUNCTION public.prune_api_idempotency_records(interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prune_api_idempotency_records(interval) TO service_role;

COMMENT ON FUNCTION public.prune_api_idempotency_records(interval) IS
  'US-2563: drop idempotency records past the retention window. Idempotent; '
  'returns the number of rows removed.';

-- US-1108: self-record so the edge schema-version boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00596') ON CONFLICT DO NOTHING;
