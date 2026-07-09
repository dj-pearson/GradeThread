-- US-1786: circularity impact factors (the Sustainability epic foundation).
--
-- A GLOBAL, NON-TENANT config table of published apparel LCA figures, keyed by
-- garment_type (+ optional material). Used by impact-estimate.ts to estimate the
-- production-phase impact AVOIDED by buying a garment secondhand instead of new:
-- CO2e, water, and landfill diverted (the garment's weight kept in use).
--
-- Deny-all RLS (RLS enabled, ZERO policies): only the service-role edge reads it;
-- the SPA never queries it directly. Registered in rls-guard_test.ts
-- SERVICE_ROLE_ONLY. Every row carries a SOURCE + version so a figure is auditable
-- and re-datable — results are always labelled an ESTIMATE with a methodology
-- link. Figures are CONSERVATIVE midpoints from openly published datasets; we do
-- NOT fabricate false precision (garment_type is coarse and material varies).

CREATE TABLE IF NOT EXISTS public.impact_factors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_type  text NOT NULL,
  -- 'default' = the type-level figure; a specific material overrides it.
  material      text NOT NULL DEFAULT 'default',
  -- Estimated production-phase impact of one NEW equivalent garment.
  co2e_kg       numeric(8,2) NOT NULL,
  water_liters  numeric(10,1) NOT NULL,
  -- Typical garment weight — the landfill diverted by keeping it in use.
  weight_kg     numeric(6,3) NOT NULL,
  source        text NOT NULL,
  version       text NOT NULL DEFAULT '2026-07',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_impact_factors_key
  ON public.impact_factors (garment_type, material);

DROP TRIGGER IF EXISTS set_impact_factors_updated_at ON public.impact_factors;
CREATE TRIGGER set_impact_factors_updated_at
  BEFORE UPDATE ON public.impact_factors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.impact_factors ENABLE ROW LEVEL SECURITY;

-- ── Seed: conservative type-level figures from published apparel LCAs ─────────
INSERT INTO public.impact_factors (garment_type, material, co2e_kg, water_liters, weight_kg, source)
VALUES
  ('tops', 'default', 2.50, 2500.0, 0.200,
   'WRAP UK + Ellen MacArthur Foundation "A New Textiles Economy" — cotton tee production (conservative)'),
  ('bottoms', 'default', 12.00, 3500.0, 0.600,
   'Levi Strauss & Co. jeans lifecycle LCA (production phase, conservative for mixed bottoms)'),
  ('outerwear', 'default', 20.00, 2000.0, 0.800,
   'Published apparel LCA datasets — synthetic-heavy outerwear (conservative)'),
  ('dresses', 'default', 10.00, 2500.0, 0.350,
   'Published apparel LCA datasets — dresses (conservative)'),
  ('footwear', 'default', 14.00, 800.0, 0.700,
   'MIT footwear lifecycle study — a pair of trainers (conservative)'),
  ('accessories', 'default', 3.00, 500.0, 0.200,
   'Published apparel LCA datasets — small accessories (conservative)')
ON CONFLICT (garment_type, material) DO NOTHING;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00408') on conflict do nothing;
