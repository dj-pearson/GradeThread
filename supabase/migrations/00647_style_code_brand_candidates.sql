-- US-2786: which brands are worth a crawl budget, measured rather than guessed.
--
-- The nightly crawl (US-2782) can only walk brands already in brand_knowledge.
-- The brands a thrift seller actually finds on a rack are invisible to it, and
-- the way to fix that is not to guess a list — it is to watch what sellers
-- actually tag. This table holds that tally.
--
-- One row per brand nobody has curated yet: how many of its listings the
-- prospect pass looked at, and how many of those DECLARED a style code in a
-- structured field. The ratio is the whole point. A brand with a million
-- listings and nobody filling the Style Code box is worth no budget at all,
-- and a small brand whose sellers all fill it is worth a great deal.
--
-- NOTHING HERE BECOMES BRAND KNOWLEDGE ON ITS OWN. A candidate is evidence for
-- a human decision; promotion still goes through the US-1718 draft-verify-seed
-- flow, which rejects a fact with no source_url. This table has no source_url
-- column for exactly that reason: it is a measurement, not a claim about a
-- brand.
--
-- Global reference bookkeeping: no owner column, deny-all RLS, service-role
-- only, registered in SERVICE_ROLE_ONLY.

CREATE TABLE IF NOT EXISTS public.style_code_brand_candidates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalized key, the same one brandKeyForRaw computes.
  brand_key            text NOT NULL UNIQUE,
  -- The spelling eBay's Brand aspect actually carries. Needed verbatim,
  -- because it is what a later crawl has to search on.
  brand_label          text NOT NULL,
  listings_seen        bigint NOT NULL DEFAULT 0,
  listings_with_code   bigint NOT NULL DEFAULT 0,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  -- pending: still accumulating evidence and awaiting a human look.
  -- promoted: a brand_knowledge row now exists, so the crawl covers it.
  -- rejected: looked at and judged not worth a crawl budget. Kept rather than
  -- deleted, so the next prospect pass does not re-surface it every night.
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'promoted', 'rejected')),
  reviewed_at          timestamptz,
  reviewed_by          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The admin read: best code-fill rate first, among brands still pending.
CREATE INDEX IF NOT EXISTS style_code_brand_candidates_status_idx
  ON public.style_code_brand_candidates (status, listings_with_code DESC);

ALTER TABLE public.style_code_brand_candidates ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant reference bookkeeping, service-role only.

DROP TRIGGER IF EXISTS set_style_code_brand_candidates_updated_at
  ON public.style_code_brand_candidates;
CREATE TRIGGER set_style_code_brand_candidates_updated_at
  BEFORE UPDATE ON public.style_code_brand_candidates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Accumulate one prospect pass's sighting of a brand.
--
-- Counters add up server-side for the reason 00646's do: two overlapping passes
-- that each read a total, incremented it and wrote it back would erase one
-- another. A REJECTED brand keeps accumulating its tally but keeps its status —
-- the evidence is still worth having if somebody revisits the decision, and
-- silently flipping it back to pending would re-ask a question already answered.
CREATE OR REPLACE FUNCTION public.record_style_code_brand_candidate(
  p_brand_key text,
  p_brand_label text,
  p_listings_seen integer DEFAULT 0,
  p_listings_with_code integer DEFAULT 0
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.style_code_brand_candidates AS c
    (brand_key, brand_label, listings_seen, listings_with_code)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    coalesce(nullif(btrim(p_brand_label), ''), btrim(p_brand_key)),
    greatest(coalesce(p_listings_seen, 0), 0),
    greatest(coalesce(p_listings_with_code, 0), 0)
  )
  ON CONFLICT (brand_key) DO UPDATE SET
    -- The label can improve: an early sighting may have caught a lowercase or
    -- abbreviated spelling, and the crawl searches on this string.
    brand_label = CASE
      WHEN length(EXCLUDED.brand_label) > length(c.brand_label)
        THEN EXCLUDED.brand_label
      ELSE c.brand_label
    END,
    listings_seen = c.listings_seen + greatest(coalesce(EXCLUDED.listings_seen, 0), 0),
    listings_with_code = c.listings_with_code
      + greatest(coalesce(EXCLUDED.listings_with_code, 0), 0),
    last_seen_at = now(),
    updated_at = now();
$$;

-- ⚠ DELIBERATELY NO REVOKE HERE, and that is not an oversight.
--
-- US-2403: on this Postgres image a DENIED function call from `anon` or
-- `authenticated` SEGFAULTS the backend and restarts the whole database,
-- because supautils appends a GRANT hint to the error. `anon` is the key that
-- ships in the browser bundle, so a revoke here creates a crash surface any
-- visitor can reach. That is why 00527 - the bulk revoke across the schema - is
-- parked as .BLOCKED, and why 00609, 00627 and 00646 carry this same note.
--
-- THE PERMISSION YOU WANT IS RIGHT AND THE IMAGE CANNOT EXPRESS IT SAFELY YET.
-- It lands with US-2282/US-2403 once supautils.hint_roles is cleared on the
-- host and scripts/db-denied-rpc-crash-check.mjs proves it.
--
-- US-2282 AC4: name the caller explicitly. This function is invoked ONLY by the
-- discovery job's prospect pass through the service-role client, which
-- authenticates on the job secret, so service_role is the whole of the intended
-- audience. The GRANT narrows nothing on its own - anon and authenticated keep
-- the CREATE FUNCTION default, because taking it away is what segfaults this
-- image - it states who the caller is, which is what the guard asks for.
GRANT EXECUTE ON FUNCTION public.record_style_code_brand_candidate(text, text, integer, integer) TO service_role;

-- The prospect pass's own cursor, so it walks fresh inventory rather than
-- re-reading eBay's first page nightly. Same reasoning as 00646's per-brand
-- cursor; a single row, because there is one unfiltered walk rather than one
-- per brand. Keyed on a fixed sentinel so the upsert has a plain-column target.
CREATE TABLE IF NOT EXISTS public.style_code_prospect_state (
  id            text PRIMARY KEY DEFAULT 'clothing',
  page_offset   integer NOT NULL DEFAULT 0 CHECK (page_offset >= 0),
  last_run_at   timestamptz,
  pass_count    integer NOT NULL DEFAULT 0,
  listings_seen bigint NOT NULL DEFAULT 0,
  brands_seen   bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.style_code_prospect_state ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant crawl bookkeeping, service-role only.

DROP TRIGGER IF EXISTS set_style_code_prospect_state_updated_at
  ON public.style_code_prospect_state;
CREATE TRIGGER set_style_code_prospect_state_updated_at
  BEFORE UPDATE ON public.style_code_prospect_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.record_style_code_prospect(
  p_next_offset integer,
  p_listings_seen integer DEFAULT 0,
  p_brands_seen integer DEFAULT 0
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.style_code_prospect_state AS p
    (id, page_offset, last_run_at, pass_count, listings_seen, brands_seen)
  VALUES (
    'clothing',
    greatest(coalesce(p_next_offset, 0), 0),
    now(),
    1,
    greatest(coalesce(p_listings_seen, 0), 0),
    greatest(coalesce(p_brands_seen, 0), 0)
  )
  ON CONFLICT (id) DO UPDATE SET
    page_offset = greatest(coalesce(EXCLUDED.page_offset, 0), 0),
    last_run_at = now(),
    pass_count = p.pass_count + 1,
    listings_seen = p.listings_seen + greatest(coalesce(EXCLUDED.listings_seen, 0), 0),
    brands_seen = p.brands_seen + greatest(coalesce(EXCLUDED.brands_seen, 0), 0),
    updated_at = now();
$$;

-- Same no-revoke reasoning as above; see the block preceding the first GRANT.
GRANT EXECUTE ON FUNCTION public.record_style_code_prospect(integer, integer, integer) TO service_role;

COMMENT ON TABLE public.style_code_brand_candidates IS
  'US-2786: brands not yet in brand_knowledge, tallied by how often their eBay '
  'listings DECLARE a style code. Evidence for a human decision - promotion '
  'still goes through the US-1718 sourced seed flow. Service-role only.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00647') on conflict do nothing;
