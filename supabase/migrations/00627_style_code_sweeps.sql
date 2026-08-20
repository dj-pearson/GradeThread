-- 00627 — sweep bookkeeping for the learned style-code index (US-2690)
--
-- 00503 records what the market CALLED a code. It cannot record that a code was
-- looked up and the market said nothing, because a zero-hit sweep produces no
-- title and therefore no row. Without that fact a background sweep re-queries
-- its own dead ends forever, which is the whole eBay budget spent on the codes
-- least likely to ever resolve.
--
-- One row per (brand, code) the sweep has attempted, whatever the outcome. Not
-- a queue: the work-list is derived from items and observations, and this table
-- only answers "have we already tried this, and how did it go?".
--
-- Aggregate reference data, same class as 00503: brand + code + counters. No
-- owner column, no seller identity, no title (titles belong in 00503). Deny-all
-- RLS; the edge service-role client is the only reader and writer.

CREATE TABLE IF NOT EXISTS public.style_code_sweeps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- brand_knowledge.brand_key, or '' when the code was seen without a brand.
  brand_key        text NOT NULL DEFAULT '',
  -- Uppercased, punctuation-stripped comparable form — matches 00503.
  style_code_norm  text NOT NULL,
  -- The code as printed on the tag, kept verbatim for display.
  style_code_raw   text NOT NULL,
  -- How many times the sweep has attempted this code.
  sweep_count      integer NOT NULL DEFAULT 1 CHECK (sweep_count > 0),
  -- Titles the MOST RECENT attempt returned. 0 means the last try was a miss.
  titles_found     integer NOT NULL DEFAULT 0 CHECK (titles_found >= 0),
  last_swept_at    timestamptz NOT NULL DEFAULT now(),
  -- Null until an attempt returns something; the cooldown reads this.
  last_hit_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Plain-column unique key so PostgREST upsert can target it (the
-- garment_baselines lesson: onConflict cannot name an expression index).
CREATE UNIQUE INDEX IF NOT EXISTS style_code_sweeps_key_idx
  ON public.style_code_sweeps (brand_key, style_code_norm);

-- The cooldown read: which codes were attempted recently, oldest first.
CREATE INDEX IF NOT EXISTS style_code_sweeps_recency_idx
  ON public.style_code_sweeps (last_swept_at);

ALTER TABLE public.style_code_sweeps ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant sweep bookkeeping, service-role only.

DROP TRIGGER IF EXISTS set_style_code_sweeps_updated_at
  ON public.style_code_sweeps;
CREATE TRIGGER set_style_code_sweeps_updated_at
  BEFORE UPDATE ON public.style_code_sweeps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Increment-or-insert in one statement. last_hit_at only moves FORWARD on a
-- hit, so a later miss cannot erase the fact that this code once resolved.
CREATE OR REPLACE FUNCTION public.record_style_code_sweep(
  p_brand_key text,
  p_style_code_norm text,
  p_style_code_raw text,
  p_titles_found integer DEFAULT 0
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.style_code_sweeps AS s
    (brand_key, style_code_norm, style_code_raw, titles_found, last_hit_at)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    p_style_code_norm,
    p_style_code_raw,
    greatest(coalesce(p_titles_found, 0), 0),
    CASE WHEN coalesce(p_titles_found, 0) > 0 THEN now() ELSE NULL END
  )
  ON CONFLICT (brand_key, style_code_norm) DO UPDATE SET
    sweep_count = s.sweep_count + 1,
    titles_found = greatest(coalesce(EXCLUDED.titles_found, 0), 0),
    last_swept_at = now(),
    last_hit_at = CASE
      WHEN coalesce(EXCLUDED.titles_found, 0) > 0 THEN now()
      ELSE s.last_hit_at
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
-- parked as .BLOCKED, and why 00609 carries this same note verbatim.
--
-- THE PERMISSION YOU WANT IS RIGHT AND THE IMAGE CANNOT EXPRESS IT SAFELY YET.
-- It lands with US-2282/US-2403 once supautils.hint_roles is cleared on the
-- host and scripts/db-denied-rpc-crash-check.mjs proves it - not smuggled in
-- beside a new table.
--
-- These two functions are SECURITY DEFINER and called only by the job route,
-- which authenticates on the job secret. Leaving the default EXECUTE in place
-- is the same posture every other function in this schema has today.
--
-- US-2282 AC4: name the caller explicitly. This function is invoked ONLY by
-- the job route through the service-role client, so service_role is the whole
-- of its intended audience. The GRANT narrows nothing on its own - anon and
-- authenticated keep the CREATE FUNCTION default, because taking it away is
-- exactly what segfaults this image - it states who the caller is, which is
-- what the guard asks for. The real lockdown lands with US-2282/US-2403.
GRANT EXECUTE ON FUNCTION public.record_style_code_sweep(text, text, text, integer) TO service_role;

-- The candidate scan, as DISTINCT pairs rather than rows.
--
-- The obvious version of this is a `select brand, attributes->>'style_code'
-- from inventory_items limit N` in the edge, deduped in JS. US-2029 already paid
-- for that mistake on this exact table: the cap applies to ROWS, so one seller
-- with N recent items starves every other seller out of the scan, and the job
-- still reports success. Distinct in the database means the cap bounds CODES,
-- which is the thing the sweep actually spends its budget on.
--
-- Reads brand + tag code only. No owner, no title, no price, no photo — this is
-- manufacturer reference data printed on a garment, and it is the one shape of
-- cross-tenant read the sweep needs.
CREATE OR REPLACE FUNCTION public.style_code_sweep_candidates(
  p_limit integer DEFAULT 20000
) RETURNS TABLE (brand text, style_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT
    coalesce(btrim(i.brand), '') AS brand,
    btrim(i.attributes->>'style_code') AS style_code
  FROM public.inventory_items i
  WHERE i.attributes->>'style_code' IS NOT NULL
    AND btrim(i.attributes->>'style_code') <> ''
  LIMIT greatest(coalesce(p_limit, 20000), 0);
$$;

-- ⚠ DELIBERATELY NO REVOKE HERE, and that is not an oversight.
--
-- US-2403: on this Postgres image a DENIED function call from `anon` or
-- `authenticated` SEGFAULTS the backend and restarts the whole database,
-- because supautils appends a GRANT hint to the error. `anon` is the key that
-- ships in the browser bundle, so a revoke here creates a crash surface any
-- visitor can reach. That is why 00527 - the bulk revoke across the schema - is
-- parked as .BLOCKED, and why 00609 carries this same note verbatim.
--
-- THE PERMISSION YOU WANT IS RIGHT AND THE IMAGE CANNOT EXPRESS IT SAFELY YET.
-- It lands with US-2282/US-2403 once supautils.hint_roles is cleared on the
-- host and scripts/db-denied-rpc-crash-check.mjs proves it - not smuggled in
-- beside a new table.
--
-- These two functions are SECURITY DEFINER and called only by the job route,
-- which authenticates on the job secret. Leaving the default EXECUTE in place
-- is the same posture every other function in this schema has today.
--
-- US-2282 AC4: name the caller explicitly. This function is invoked ONLY by
-- the job route through the service-role client, so service_role is the whole
-- of its intended audience. The GRANT narrows nothing on its own - anon and
-- authenticated keep the CREATE FUNCTION default, because taking it away is
-- exactly what segfaults this image - it states who the caller is, which is
-- what the guard asks for. The real lockdown lands with US-2282/US-2403.
GRANT EXECUTE ON FUNCTION public.style_code_sweep_candidates(integer) TO service_role;

-- Makes the scan above an index scan rather than a walk of the largest table.
CREATE INDEX IF NOT EXISTS inventory_items_style_code_idx
  ON public.inventory_items ((attributes->>'style_code'))
  WHERE attributes->>'style_code' IS NOT NULL;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00627') on conflict do nothing;
