-- 00502 — resolved RN/CA registrants (US-2244)
--
-- The lazy other half of 00501: an operator works the most-sighted unresolved
-- numbers and records who each one belongs to, one row per registry number.
-- Coverage then grows in the order the numbers actually arrive.
--
-- brand_keys is the ONLY thing that can feed the cross-check index, and only for
-- keys that exist in brand_knowledge — a registrant is a COMPANY, and a company
-- is not a brand. A row with a company_name and no brand_keys is still useful (a
-- reviewer can read "registered to Delta Apparel Inc."), but it must never mint a
-- brand. See vault/20-domain/brands/brand-kb-decoder-bar.md.
--
-- Non-tenant reference data, deny-all RLS, service-role and admin routes only.

CREATE TABLE IF NOT EXISTS public.registered_number_registry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical comparable form, matching registered_number_sightings.registry_key.
  registry_key  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('RN', 'CA')),
  digits        text NOT NULL,
  -- The registrant as the registry names it. Display + reviewer note only.
  company_name  text,
  -- brand_knowledge.brand_key values this registrant's labels resolve to. Empty
  -- is normal and means "company known, brands not established".
  brand_keys    text[] NOT NULL DEFAULT '{}',
  source_url    text,
  notes         text,
  verified      boolean NOT NULL DEFAULT false,
  resolved_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS registered_number_registry_key_idx
  ON public.registered_number_registry (registry_key);

ALTER TABLE public.registered_number_registry ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: global reference data with no owner. The edge
-- service-role client reads it to build the cross-check index; admin routes write it.

DROP TRIGGER IF EXISTS set_registered_number_registry_updated_at
  ON public.registered_number_registry;
CREATE TRIGGER set_registered_number_registry_updated_at
  BEFORE UPDATE ON public.registered_number_registry
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00502') on conflict do nothing;
