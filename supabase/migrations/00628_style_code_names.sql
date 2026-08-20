-- 00628 — the resolved NAME for a style code, and where it came from (US-2691)
--
-- 00503 stores every title the market gave a code. That is evidence. This
-- stores the ANSWER, one row per source, so the read path does not recompute a
-- consensus over a dozen titles on every extraction.
--
-- One row per (brand, code, source), not one row per code. The sources arrive
-- in different stories and disagree by design:
--
--   consensus  the run of words a majority of listings share (US-2691)
--   seller     a seller corrected it on their own item (US-2692)
--   admin      curated by hand in the brand-knowledge surface (US-2693)
--   official   the brand's own published product name (US-2694)
--
-- PRECEDENCE LIVES IN CODE, not in a rank column here. lib/style-code-names.ts
-- owns it and is unit-tested; a number in this table would be a second copy of
-- the same rule that could disagree with the first.
--
-- Aggregate reference data, same class as 00503 and 00627: brand, code, name,
-- and a public evidence URL. No owner column and no seller identity — a
-- seller-sourced row records WHAT was corrected, never by whom. Deny-all RLS.

CREATE TABLE IF NOT EXISTS public.style_code_names (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- brand_knowledge.brand_key, or '' when the code was seen without a brand.
  brand_key        text NOT NULL DEFAULT '',
  -- Uppercased, punctuation-stripped comparable form — matches 00503.
  style_code_norm  text NOT NULL,
  -- The code as printed on the tag, kept verbatim for display.
  style_code_raw   text NOT NULL,
  -- The product name, as a human would write it on a listing.
  name             text NOT NULL CHECK (btrim(name) <> ''),
  source           text NOT NULL
                     CHECK (source IN ('consensus', 'seller', 'admin', 'official')),
  -- How many independent titles/observations back this name. 1 for a hand or
  -- first-party answer, which needs no corroboration to be worth more.
  supporting       integer NOT NULL DEFAULT 1 CHECK (supporting > 0),
  confidence       numeric(3,2) NOT NULL
                     CHECK (confidence >= 0 AND confidence <= 1),
  -- A public listing or catalogue URL. Never a seller id, buyer id or price.
  evidence_url     text,
  -- US-2693: a rejected name is recorded, not deleted, so the sweep cannot
  -- re-learn it from the same evidence next tick.
  rejected_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Plain-column unique key so PostgREST upsert can target it (the
-- garment_baselines lesson: onConflict cannot name an expression index).
CREATE UNIQUE INDEX IF NOT EXISTS style_code_names_key_idx
  ON public.style_code_names (brand_key, style_code_norm, source);

-- The read path: every source for one code, so precedence is applied in code.
CREATE INDEX IF NOT EXISTS style_code_names_lookup_idx
  ON public.style_code_names (style_code_norm)
  WHERE rejected_at IS NULL;

ALTER TABLE public.style_code_names ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant learned reference, service-role only.

DROP TRIGGER IF EXISTS set_style_code_names_updated_at
  ON public.style_code_names;
CREATE TRIGGER set_style_code_names_updated_at
  BEFORE UPDATE ON public.style_code_names
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Upsert one source's answer. A re-run with the same name and a larger
-- supporting count is the normal case (the sweep found two more listings).
--
-- A rejected row STAYS rejected on a re-record of the SAME name: that is the
-- point of recording a rejection rather than deleting the row. A DIFFERENT name
-- clears it, because the rejection was about the old answer.
CREATE OR REPLACE FUNCTION public.record_style_code_name(
  p_brand_key text,
  p_style_code_norm text,
  p_style_code_raw text,
  p_name text,
  p_source text,
  p_supporting integer DEFAULT 1,
  p_confidence numeric DEFAULT 0.5,
  p_evidence_url text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.style_code_names AS n
    (brand_key, style_code_norm, style_code_raw, name, source, supporting,
     confidence, evidence_url)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    p_style_code_norm,
    p_style_code_raw,
    btrim(p_name),
    p_source,
    greatest(coalesce(p_supporting, 1), 1),
    least(greatest(coalesce(p_confidence, 0.5), 0), 1),
    p_evidence_url
  )
  ON CONFLICT (brand_key, style_code_norm, source) DO UPDATE SET
    style_code_raw = EXCLUDED.style_code_raw,
    name = EXCLUDED.name,
    supporting = EXCLUDED.supporting,
    confidence = EXCLUDED.confidence,
    evidence_url = coalesce(EXCLUDED.evidence_url, n.evidence_url),
    rejected_at = CASE
      WHEN n.name IS DISTINCT FROM EXCLUDED.name THEN NULL
      ELSE n.rejected_at
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
-- host and scripts/db-denied-rpc-crash-check.mjs proves it - not smuggled in
-- beside a new table.

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00628') on conflict do nothing;
