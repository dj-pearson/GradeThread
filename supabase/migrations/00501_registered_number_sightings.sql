-- 00501 — RN/CA sighting counters (US-2243)
--
-- The RN cross-check (US-2211) resolves a care-label registry number against
-- brand_knowledge.registered_numbers, and six brands carry one — so nearly every
-- real read comes back `no_reference`. The FTC registry has no API and no bulk
-- download, so this table inverts the problem: count the numbers that actually
-- arrive, and resolve those (US-2244) instead of importing 100k rows.
--
-- AGGREGATE ONLY: one row per registry number, no owner column and no item
-- reference, so a sighting cannot say which seller photographed the tag.
-- Deny-all RLS; written and read by the service-role edge client only.

CREATE TABLE IF NOT EXISTS public.registered_number_sightings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical comparable form from registeredNumberKey(): 'RN:87370' / 'CA:32054'.
  registry_key    text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('RN', 'CA')),
  digits          text NOT NULL,
  sighting_count  integer NOT NULL DEFAULT 1 CHECK (sighting_count > 0),
  -- Canonical brand names declared alongside this number, deduped. A crowd of
  -- one brand is a strong hint for whoever resolves it; a crowd of many says the
  -- number is a shared registrant (the URBN case) before anyone looks it up.
  declared_brands text[] NOT NULL DEFAULT '{}',
  resolved        boolean NOT NULL DEFAULT false,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS registered_number_sightings_key_idx
  ON public.registered_number_sightings (registry_key);

-- The work queue: unresolved, most-sighted first.
CREATE INDEX IF NOT EXISTS registered_number_sightings_queue_idx
  ON public.registered_number_sightings (resolved, sighting_count DESC);

ALTER TABLE public.registered_number_sightings ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: non-tenant aggregate counters. The edge service-role
-- client increments them; the admin queue (US-2244) reads them.

DROP TRIGGER IF EXISTS set_registered_number_sightings_updated_at
  ON public.registered_number_sightings;
CREATE TRIGGER set_registered_number_sightings_updated_at
  BEFORE UPDATE ON public.registered_number_sightings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Increment-or-insert in ONE statement, so two concurrent grading passes reading
-- the same tag cannot lose a count to a read-modify-write race. Returns nothing:
-- the caller is fire-and-forget and must never block a grade on bookkeeping.
CREATE OR REPLACE FUNCTION public.record_registered_number_sighting(
  p_registry_key text,
  p_kind text,
  p_digits text,
  p_declared_brand text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.registered_number_sightings AS s
    (registry_key, kind, digits, declared_brands)
  VALUES (
    p_registry_key,
    p_kind,
    p_digits,
    CASE
      WHEN coalesce(btrim(p_declared_brand), '') = '' THEN '{}'::text[]
      ELSE ARRAY[btrim(p_declared_brand)]
    END
  )
  ON CONFLICT (registry_key) DO UPDATE SET
    sighting_count = s.sighting_count + 1,
    last_seen_at = now(),
    updated_at = now(),
    declared_brands = CASE
      WHEN coalesce(btrim(p_declared_brand), '') = '' THEN s.declared_brands
      WHEN btrim(p_declared_brand) = ANY (s.declared_brands) THEN s.declared_brands
      ELSE s.declared_brands || btrim(p_declared_brand)
    END;
$$;

REVOKE ALL ON FUNCTION public.record_registered_number_sighting(text, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_registered_number_sighting(text, text, text, text)
  FROM anon, authenticated;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00501') on conflict do nothing;
