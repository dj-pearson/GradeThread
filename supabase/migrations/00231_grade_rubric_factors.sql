-- Category-specific grading rubrics — additive foundation (US: non-clothing grading).
--
-- Condition grading is currently clothing-only: the 5 factor columns below
-- (fabric/structural/cosmetic/functional/odor) are hardcoded for garments. To
-- grade sports cards (corners/edges/surface/centering), watches, shoes, etc.,
-- different rubrics have different factor sets — which the 5 fixed columns can't
-- represent. Rather than add per-category columns, store the chosen rubric's
-- factor map generically.
--
-- This migration is PURELY ADDITIVE and changes NO existing behavior:
--   * factor_scores  — JSONB map of { <factor_key>: <0.0-10.0 score> } for the
--                      rubric that graded this item. NULL on every existing row;
--                      clothing reports keep populating the 5 typed columns and
--                      MAY also mirror them here once the pipeline is activated.
--   * rubric_key     — which rubric produced factor_scores (e.g. 'clothing',
--                      'sports_cards', 'watches', 'shoes'). NULL = legacy/clothing
--                      report read from the typed columns.
--
-- The public certificate view (public_grade_reports, migration 00082) is NOT
-- changed here — it still projects the typed clothing columns. Exposing
-- factor_scores/rubric_key to anonymous viewers happens in the activation phase
-- (when the grading pipeline actually writes them), recreating the view with its
-- full current column set at that time.
ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS factor_scores jsonb,
  ADD COLUMN IF NOT EXISTS rubric_key    text;

COMMENT ON COLUMN public.grade_reports.factor_scores IS
  'Generic { factor_key: score } map for the rubric that graded this item '
  '(non-clothing categories). NULL for legacy/clothing rows read from the typed '
  'fabric_/structural_/cosmetic_/functional_/odor_ columns.';
COMMENT ON COLUMN public.grade_reports.rubric_key IS
  'Rubric that produced factor_scores (clothing, sports_cards, watches, shoes, …). '
  'NULL = legacy clothing report scored via the typed factor columns.';
