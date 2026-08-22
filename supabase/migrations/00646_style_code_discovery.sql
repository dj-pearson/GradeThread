-- US-2783: where the brand-first style-code crawl stopped.
--
-- The US-2690 sweep asks the market about codes we have already met. The US-2782
-- crawl runs the other direction: page a brand's live listings and keep the codes
-- sellers already typed into eBay's structured fields, so a code nobody here has
-- listed is answered before anyone asks for it.
--
-- A crawl with no cursor re-reads page one every night and reports success, which
-- is the specific way this kind of job looks healthy and learns nothing. That is
-- what this table is for and the only thing it is for.
--
-- Global reference bookkeeping: no owner column, deny-all RLS, service-role only,
-- registered in SERVICE_ROLE_ONLY in rls-guard_test.ts. Nothing tenant-shaped is
-- recorded here — a brand name, an offset and four counters.
--
-- "page_offset", not "cursor": CURSOR is a reserved word in Postgres and a column
-- that needs quoting at every call site is a column somebody eventually forgets
-- to quote.

CREATE TABLE IF NOT EXISTS public.style_code_discovery_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key        text NOT NULL UNIQUE,
  -- Where the next pass starts paging. Reaches eBay's 10,000 limit + offset
  -- ceiling and wraps to 0 on the next pick.
  page_offset      integer NOT NULL DEFAULT 0 CHECK (page_offset >= 0),
  last_run_at      timestamptz,
  pass_count       integer NOT NULL DEFAULT 0,
  listings_seen    bigint NOT NULL DEFAULT 0,
  codes_found      bigint NOT NULL DEFAULT 0,
  -- Consecutive passes that found no code the index did not already hold. The
  -- crawl treats a brand as exhausted at three and backs off to a long cooldown.
  empty_passes     integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The rotation read: least recently crawled first, never-crawled ahead of all.
CREATE INDEX IF NOT EXISTS style_code_discovery_state_recency_idx
  ON public.style_code_discovery_state (last_run_at NULLS FIRST);

ALTER TABLE public.style_code_discovery_state ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant crawl bookkeeping, service-role only.

DROP TRIGGER IF EXISTS set_style_code_discovery_state_updated_at
  ON public.style_code_discovery_state;
CREATE TRIGGER set_style_code_discovery_state_updated_at
  BEFORE UPDATE ON public.style_code_discovery_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Accumulate a pass in one statement.
--
-- The counters add up server-side rather than being read, incremented and
-- written back by the job: two ticks that overlapped would each write a total
-- computed before the other's pass, and the second would erase the first.
CREATE OR REPLACE FUNCTION public.record_style_code_discovery(
  p_brand_key text,
  p_next_offset integer,
  p_listings_seen integer DEFAULT 0,
  p_codes_found integer DEFAULT 0,
  p_new_codes integer DEFAULT 0
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.style_code_discovery_state AS d
    (brand_key, page_offset, last_run_at, pass_count, listings_seen,
     codes_found, empty_passes)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    greatest(coalesce(p_next_offset, 0), 0),
    now(),
    1,
    greatest(coalesce(p_listings_seen, 0), 0),
    greatest(coalesce(p_codes_found, 0), 0),
    CASE WHEN coalesce(p_new_codes, 0) > 0 THEN 0 ELSE 1 END
  )
  ON CONFLICT (brand_key) DO UPDATE SET
    page_offset = greatest(coalesce(EXCLUDED.page_offset, 0), 0),
    last_run_at = now(),
    pass_count = d.pass_count + 1,
    listings_seen = d.listings_seen + greatest(coalesce(EXCLUDED.listings_seen, 0), 0),
    codes_found = d.codes_found + greatest(coalesce(EXCLUDED.codes_found, 0), 0),
    -- Reset on any new code, so a brand that starts yielding again stops being
    -- treated as exhausted without anyone clearing a flag by hand.
    empty_passes = CASE
      WHEN coalesce(p_new_codes, 0) > 0 THEN 0
      ELSE d.empty_passes + 1
    END,
    updated_at = now();
$$;

-- ⚠ DELIBERATELY NO REVOKE HERE, and that is not an oversight.
--
-- US-2403: on this Postgres image a DENIED function call from `anon` or
-- `authenticated` SEGFAULTS the backend and restarts the whole database,
-- because supautils appends a GRANT hint to the error. `anon` is the key that
-- ships in the browser bundle, so a revoke here creates a crash surface any
-- visitor can reach. That is why 00527 - the bulk revoke across the schema - is
-- parked as .BLOCKED, and why 00609 and 00627 carry this same note.
--
-- THE PERMISSION YOU WANT IS RIGHT AND THE IMAGE CANNOT EXPRESS IT SAFELY YET.
-- It lands with US-2282/US-2403 once supautils.hint_roles is cleared on the
-- host and scripts/db-denied-rpc-crash-check.mjs proves it.
--
-- US-2282 AC4: name the caller explicitly. Both functions here are invoked ONLY
-- by the discovery job route through the service-role client, which
-- authenticates on the job secret, so service_role is the whole of the intended
-- audience. The GRANT narrows nothing on its own - anon and authenticated keep
-- the CREATE FUNCTION default, because taking it away is what segfaults this
-- image - it states who the caller is, which is what the guard asks for.
GRANT EXECUTE ON FUNCTION public.record_style_code_discovery(text, integer, integer, integer, integer) TO service_role;

-- The brand rotation, joined to its cursor.
--
-- A function rather than two client reads stitched in JS, for the reason 00627's
-- candidate scan is one: a cap applied client-side bounds ROWS, and whichever
-- brands sort late are starved out of every tick while the job reports success.
-- Here the cap bounds BRANDS, which is what the budget is spent on.
--
-- Reads brand_knowledge only: a brand name and its display spelling. No tenant
-- data of any kind is reachable from this function.
CREATE OR REPLACE FUNCTION public.style_code_discovery_brands(
  p_limit integer DEFAULT 500
) RETURNS TABLE (
  brand_key text,
  brand_label text,
  page_offset integer,
  last_run_at timestamptz,
  empty_passes integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.brand_key,
    coalesce(nullif(btrim(b.canonical_brand), ''), b.brand_key) AS brand_label,
    coalesce(d.page_offset, 0) AS page_offset,
    d.last_run_at,
    coalesce(d.empty_passes, 0) AS empty_passes
  FROM public.brand_knowledge b
  LEFT JOIN public.style_code_discovery_state d
    ON d.brand_key = b.brand_key
  WHERE btrim(coalesce(b.brand_key, '')) <> ''
  ORDER BY d.last_run_at ASC NULLS FIRST, b.brand_key ASC
  LIMIT greatest(coalesce(p_limit, 500), 0);
$$;

-- Same no-revoke reasoning as above; see the block preceding the first GRANT.
GRANT EXECUTE ON FUNCTION public.style_code_discovery_brands(integer) TO service_role;

-- ── Admit 'discovery' as an observation source ──────────────────────────────
--
-- A crawl finding a code is not the same act as verifying a code we asked
-- about, and the index is worth less if both arrive stamped 'market_verify'.
-- Drop-and-add rather than ALTER: a CHECK constraint cannot be widened in
-- place, and this is the shape 00635 used on style_code_names. No backfill and
-- no existing row is touched - every current value stays valid.
ALTER TABLE public.style_code_observations
  DROP CONSTRAINT IF EXISTS style_code_observations_source_check;

ALTER TABLE public.style_code_observations
  ADD CONSTRAINT style_code_observations_source_check
  CHECK (source IN ('market_verify', 'own_sale', 'admin', 'discovery'));

COMMENT ON TABLE public.style_code_discovery_state IS
  'US-2783: per-brand cursor for the brand-first style-code crawl. Non-tenant '
  'bookkeeping, service-role only. Without it a crawl re-reads page one nightly '
  'and reports success.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00646') on conflict do nothing;
