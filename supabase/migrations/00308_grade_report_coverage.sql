-- 00308_grade_report_coverage.sql
--
-- US-1276: persist the 2D photo coverage-scoring result on each grade report.
--
-- The grading pipeline (lib/coverage.ts) computes which standard inspection
-- zones of the garment the submitted photos actually documented — covered_zones,
-- missing_zones, and coverage_pct (0–100) — keyed off garment_category so a zone
-- the garment type does not have (a scarf has no pockets) is excluded from the
-- denominator. This is the keystone for the coverage-gated guarantee
-- (US-1279/1280): a grade — and any remedy promise — can be scoped to what was
-- actually shown. Stored as jsonb; nullable so historical reports (graded before
-- this column existed) stay valid and simply carry no coverage record.
--
-- Idempotent (US-1108): ADD COLUMN IF NOT EXISTS + self-record footer.

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS coverage jsonb;

COMMENT ON COLUMN public.grade_reports.coverage IS
  'US-1276: 2D inspection-zone coverage from the submitted photos — '
  '{garment_category, applicable_zones[], covered_zones[], missing_zones[], '
  'coverage_pct}. Null for reports graded before this column existed.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00308')
ON CONFLICT (version) DO NOTHING;
