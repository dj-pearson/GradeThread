-- US-1773: cross-garment durability aggregation.
--
-- Rolls up per-garment condition curves (passport-curve.ts buildConditionCurve,
-- over public_grade_reports) across garments by sku_class (brand + garment type)
-- into cohort durability metrics: how much condition a class retains on regrade,
-- which factors decay fastest, and — where sold-event prices exist — resale
-- value by condition band. Sample-gated (min garments + min regrades) so a thin
-- cohort never ships a false "brand X lasts longer" claim, mirroring the
-- condition-index sample floor.
--
-- GLOBAL, NON-TENANT reference data (no owner): deny-all RLS (no policy) — only
-- the service-role aggregation job writes it and the public rankings endpoint
-- (US-1774) reads it. Registered in rls-guard_test.ts SERVICE_ROLE_ONLY.
-- Aggregate-only + PII-safe: no per-listing price, no buyer, no node identity.

CREATE TABLE IF NOT EXISTS public.durability_aggregates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical cohort key, e.g. "gucci::outerwear". Unique per class.
  sku_class_key         text NOT NULL,
  brand                 text,
  garment_type          text,
  label                 text NOT NULL,
  -- Cohort sizes (the sample gate inputs).
  garment_count         integer NOT NULL DEFAULT 0,
  regraded_count        integer NOT NULL DEFAULT 0,
  -- Condition durability across regrades (null until enough regraded garments).
  avg_overall_decay     numeric(4,2),
  avg_retention         numeric(5,4),
  avg_span_days         numeric(8,2),
  -- Per-factor average points lost on regrade: { fabric_condition_score: 0.7, ... }.
  per_factor_decay      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Resale value signal from sold events (null until enough sales).
  resale_sample         integer NOT NULL DEFAULT 0,
  resale_median_cents   integer,
  -- Median resale by condition band at sale: { excellent, good, fair }.
  resale_by_band        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Did the cohort clear the durability sample gate?
  sufficient            boolean NOT NULL DEFAULT false,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_durability_aggregates_key
  ON public.durability_aggregates(sku_class_key);
CREATE INDEX IF NOT EXISTS idx_durability_aggregates_sufficient
  ON public.durability_aggregates(sufficient) WHERE sufficient = true;

DROP TRIGGER IF EXISTS set_durability_aggregates_updated_at ON public.durability_aggregates;
CREATE TRIGGER set_durability_aggregates_updated_at
  BEFORE UPDATE ON public.durability_aggregates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Deny-all RLS: service-role writes (the job) + service-role reads (the public
-- rankings endpoint). No policy is created, so RLS denies all direct client
-- access. Registered in rls-guard_test.ts SERVICE_ROLE_ONLY.
ALTER TABLE public.durability_aggregates ENABLE ROW LEVEL SECURITY;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00406') on conflict do nothing;
