-- 00503 — learned style-code → product observations (US-2246)
--
-- No vendor sells a style-code database: every brand runs a private code
-- namespace. But the market confirms codes for us constantly — US-1528 already
-- searches live listings for a transcribed code to verify an identification, and
-- then throws the answer away. This table keeps it.
--
-- Evidence, not truth: a row says "listings carrying this code were titled X",
-- which is why confidence is derived from seen_count and capped below a verified
-- brand_style_codes decoder hit. A learned row can hint; it can never overrule a
-- decoder or a research identification.
--
-- Aggregate reference data: brand + code + public listing title/URL only. No
-- owner column, no seller or buyer identity, no price history. Deny-all RLS.

CREATE TABLE IF NOT EXISTS public.style_code_observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- brand_knowledge.brand_key, or '' when the code was seen without a brand.
  brand_key        text NOT NULL DEFAULT '',
  -- Uppercased, punctuation-stripped comparable form of the code.
  style_code_norm  text NOT NULL,
  -- The code as printed on the tag, kept verbatim for display.
  style_code_raw   text NOT NULL,
  -- The product title the market gave this code.
  product_title    text NOT NULL,
  -- market_verify = confirmed against live listings (US-1528)
  -- own_sale       = one of our own listings carrying this code sold
  -- admin          = curated by hand
  source           text NOT NULL DEFAULT 'market_verify'
                     CHECK (source IN ('market_verify', 'own_sale', 'admin')),
  -- A public listing URL. Never a seller id, buyer id or price.
  evidence_url     text,
  seen_count       integer NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Plain-column unique key so PostgREST upsert can target it (the
-- garment_baselines lesson: onConflict cannot name an expression index).
CREATE UNIQUE INDEX IF NOT EXISTS style_code_observations_key_idx
  ON public.style_code_observations (brand_key, style_code_norm, product_title);

-- The read path: every title ever seen for one code, most-confirmed first.
CREATE INDEX IF NOT EXISTS style_code_observations_lookup_idx
  ON public.style_code_observations (style_code_norm, seen_count DESC);

ALTER TABLE public.style_code_observations ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant learned reference. The edge service-role
-- client writes it during identification verify and reads it during extraction.

DROP TRIGGER IF EXISTS set_style_code_observations_updated_at
  ON public.style_code_observations;
CREATE TRIGGER set_style_code_observations_updated_at
  BEFORE UPDATE ON public.style_code_observations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Increment-or-insert in one statement: two verify passes on the same code must
-- not race a count away, and the caller is fire-and-forget.
CREATE OR REPLACE FUNCTION public.record_style_code_observation(
  p_brand_key text,
  p_style_code_norm text,
  p_style_code_raw text,
  p_product_title text,
  p_source text DEFAULT 'market_verify',
  p_evidence_url text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.style_code_observations AS o
    (brand_key, style_code_norm, style_code_raw, product_title, source, evidence_url)
  VALUES (
    coalesce(btrim(p_brand_key), ''),
    p_style_code_norm,
    p_style_code_raw,
    p_product_title,
    coalesce(p_source, 'market_verify'),
    p_evidence_url
  )
  ON CONFLICT (brand_key, style_code_norm, product_title) DO UPDATE SET
    seen_count = o.seen_count + 1,
    last_seen_at = now(),
    updated_at = now(),
    -- Keep the first evidence URL; later confirmations only add weight.
    evidence_url = coalesce(o.evidence_url, EXCLUDED.evidence_url);
$$;

REVOKE ALL ON FUNCTION public.record_style_code_observation(text, text, text, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_style_code_observation(text, text, text, text, text, text)
  FROM anon, authenticated;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00503') on conflict do nothing;
