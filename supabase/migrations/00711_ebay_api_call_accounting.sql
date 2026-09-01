-- US-3042: count every eBay API call, because the growth check asks for the number.
--
-- eBay will not raise a call limit for an application that cannot say what its
-- current usage is, and the application form asks for a call volume estimate
-- outright. The edge service made eBay calls through three well-behaved
-- choke points that throttled, retried and backed off correctly, and recorded
-- nothing. So the honest answer to "how many calls a day do you make" was a
-- guess.
--
-- TWO TABLES, TWO DIFFERENT ANSWERS, ON PURPOSE.
--
--   ebay_api_call_daily     what WE observed ourselves sending
--   ebay_rate_limit_snapshots   what EBAY says we consumed
--
-- They will not agree exactly, and the gap is the point. Ours counts attempts
-- including retries and network failures that never reached eBay; eBay's counts
-- what landed against the quota. A widening gap means retries are burning
-- budget. A reviewer comparing our stated volume against their own telemetry is
-- doing the same subtraction, so we should be able to explain it first.
--
-- WHY A DAILY ROLLUP AND NOT AN EVENT ROW. At the limit we are asking for, an
-- event table is 25,000 inserts a day for a number nobody reads per-row. The
-- rollup answers every question we actually have (calls per day, per API family,
-- per endpoint, and what fraction were 429s) at four figures of rows a year.
-- Buffered in the edge process and flushed on an interval, so a call costs an
-- increment on a map rather than a round trip.
--
-- ENDPOINT CARDINALITY IS CAPPED BY CONSTRUCTION. Paths are templated before
-- they get here (/sell/inventory/v1/inventory_item/{id}), so a per-SKU call does
-- not mint a row per SKU. See normalizeEbayEndpoint in lib/ebay-call-log.ts;
-- that function is the reason this table stays small, and a change to it that
-- lets a raw id through would quietly turn a rollup into an event log.
--
-- Operator tables: deny-all RLS, service-role writes only, never read by the
-- SPA. Both registered in SERVICE_ROLE_ONLY in rls-guard_test.ts.

CREATE TABLE IF NOT EXISTS public.ebay_api_call_daily (
  -- UTC day. eBay's own call limits reset on a UTC day boundary, so counting on
  -- any other calendar would compare two different days.
  day            DATE NOT NULL,
  -- eBay API family: 'inventory' | 'fulfillment' | 'account' | 'finances' |
  -- 'marketing' | 'browse' | 'taxonomy' | 'insights' | 'logistics' |
  -- 'compliance' | 'postorder' | 'notification' | 'trading' | 'oauth' | 'other'.
  -- eBay publishes limits per family, so this is the grain their quota uses.
  api            TEXT NOT NULL,
  -- Templated request path. Never a raw id.
  endpoint       TEXT NOT NULL,
  method         TEXT NOT NULL,
  -- '2xx' | '4xx' | '429' | '5xx' | 'error'. 429 is split out from 4xx because
  -- it is the one that means we are at the ceiling, which is the whole question.
  -- 'error' is a call that never got a response (timeout, DNS, connection).
  status_class   TEXT NOT NULL,
  calls          BIGINT NOT NULL DEFAULT 0,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ebay_api_call_daily_pk
    PRIMARY KEY (day, api, endpoint, method, status_class),
  CONSTRAINT ebay_api_call_daily_calls_ck CHECK (calls >= 0)
);

-- The two query shapes: "calls per day" (the chart we attach to the
-- application) and "what is 429ing lately" (the operational one).
CREATE INDEX IF NOT EXISTS idx_ebay_api_call_daily_day
  ON public.ebay_api_call_daily (day DESC);
CREATE INDEX IF NOT EXISTS idx_ebay_api_call_daily_status
  ON public.ebay_api_call_daily (status_class, day DESC)
  WHERE status_class IN ('429', '5xx', 'error');

ALTER TABLE public.ebay_api_call_daily ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ebay_rate_limit_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- As reported by eBay's Analytics API getRateLimits.
  api_name       TEXT NOT NULL,
  api_context    TEXT,
  api_version    TEXT,
  resource_name  TEXT NOT NULL,
  -- The quota itself, straight from eBay. `remaining` is what makes this worth
  -- storing: it is eBay's own statement of how close we are to the ceiling, and
  -- it is the number the growth check reviewer can verify against their side.
  limit_count    BIGINT,
  remaining      BIGINT,
  time_window_s  BIGINT,
  reset_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ebay_rate_limit_snapshots_at
  ON public.ebay_rate_limit_snapshots (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ebay_rate_limit_snapshots_resource
  ON public.ebay_rate_limit_snapshots (resource_name, captured_at DESC);

ALTER TABLE public.ebay_rate_limit_snapshots ENABLE ROW LEVEL SECURITY;

-- Deny-all on both: no policies. The service-role edge client bypasses RLS to
-- write; anon/authenticated get nothing. These describe platform-wide traffic,
-- not any one seller's, so there is no tenant scoping that would make them
-- readable — a policy here would leak aggregate business volume.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON public.ebay_api_call_daily FROM anon, authenticated';
  EXECUTE 'REVOKE ALL ON public.ebay_rate_limit_snapshots FROM anon, authenticated';
EXCEPTION WHEN OTHERS THEN
  NULL; -- roles may not exist on a bare local stack
END
$$;

-- Atomic batched increment. The edge flushes a buffer of counters; doing that as
-- read-then-write would lose increments whenever two containers flush the same
-- bucket at once, which is the normal case with more than one replica. ON
-- CONFLICT DO UPDATE makes each bucket's increment atomic without a transaction
-- the caller has to hold.
--
-- Input shape: [{"day":"2026-09-01","api":"inventory",
--                "endpoint":"/sell/inventory/v1/offer","method":"POST",
--                "status_class":"2xx","calls":42}, ...]
CREATE OR REPLACE FUNCTION public.bump_ebay_api_calls(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_applied INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN 0;
  END IF;

  INSERT INTO public.ebay_api_call_daily AS d
    (day, api, endpoint, method, status_class, calls)
  SELECT
    (r->>'day')::DATE,
    LEFT(r->>'api', 40),
    LEFT(r->>'endpoint', 200),
    LEFT(r->>'method', 10),
    LEFT(r->>'status_class', 10),
    GREATEST((r->>'calls')::BIGINT, 0)
  FROM jsonb_array_elements(p_rows) AS r
  WHERE r->>'day' IS NOT NULL
    AND r->>'api' IS NOT NULL
    AND r->>'endpoint' IS NOT NULL
    AND r->>'method' IS NOT NULL
    AND r->>'status_class' IS NOT NULL
  ON CONFLICT ON CONSTRAINT ebay_api_call_daily_pk DO UPDATE
    SET calls = d.calls + EXCLUDED.calls,
        updated_at = NOW();

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN v_applied;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_ebay_api_calls(JSONB) FROM PUBLIC;
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.bump_ebay_api_calls(JSONB) FROM anon, authenticated';
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

COMMENT ON TABLE public.ebay_api_call_daily IS
  'US-3042: daily rollup of eBay API calls we sent, by family/endpoint/method/status. '
  'Endpoints are templated (no raw ids) so cardinality stays bounded. '
  'Deny-all RLS; service-role writes only via bump_ebay_api_calls().';
COMMENT ON TABLE public.ebay_rate_limit_snapshots IS
  'US-3042: eBay Analytics getRateLimits responses — eBay''s own view of our '
  'quota consumption, kept alongside our self-count so the two can be compared. '
  'Deny-all RLS; service-role writes only.';

-- US-3042: the deletion compliance log now records the BUYER erasure too, not
-- only the seller-connection deactivation. Without this column the log says a
-- notification was handled and cannot say what was actually removed, which is
-- precisely the question an eBay compliance review asks.
ALTER TABLE public.ebay_account_deletion_log
  ADD COLUMN IF NOT EXISTS buyer_rows_erased INTEGER NOT NULL DEFAULT 0;

insert into public.applied_migrations (version) values ('00711') on conflict do nothing;
