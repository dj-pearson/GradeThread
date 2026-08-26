-- US-2917: record what a size chart's numbers MEAN.
--
-- Every chart in brand_size_charts holds BODY measurements — the wearer's
-- chest, not the garment's — and the size checker converts them to expected
-- flat-lay ranges by adding garment ease and halving the circumference. A brand
-- that publishes garment-flat specs instead would get ease added on top of
-- ease, and every correctly sized item on that brand would be flagged.
--
-- The column exists so that case can be recorded honestly rather than worked
-- around by editing the numbers. Default 'body' is correct for every row that
-- exists today: the whole corpus was seeded from sizing-charts.ts, whose header
-- states the values are body/garment approximations and whose athleisure block
-- (00452) says outright "All BODY measurements, never flat-garment".

ALTER TABLE public.brand_size_charts
  ADD COLUMN IF NOT EXISTS measurement_basis text NOT NULL DEFAULT 'body';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_size_charts_measurement_basis_check'
      AND conrelid = 'public.brand_size_charts'::regclass
  ) THEN
    ALTER TABLE public.brand_size_charts
      ADD CONSTRAINT brand_size_charts_measurement_basis_check
      CHECK (measurement_basis IN ('body', 'flat'));
  END IF;
END $$;

COMMENT ON COLUMN public.brand_size_charts.measurement_basis IS
  'body = the wearer''s measurements (the default, and what every seeded chart holds); flat = the garment laid flat, as some brands publish. The band builder adds ease only to body charts.';

insert into public.applied_migrations (version) values ('00674') on conflict do nothing;
