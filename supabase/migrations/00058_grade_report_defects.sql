-- Auto-Disclosure Engine — persist the genuine defects the grader already finds.
--
-- The composite grading step produces `defects_found` (GENUINE wear/damage,
-- separated from intentional design), but the pipeline only ever wrote a
-- free-text "defects_summary" into detailed_notes — the structured list was
-- discarded. Persisting it lets us auto-generate a documented "Condition &
-- Flaws" disclosure for listings and AI-annotated defect photos, which is the
-- single best defense against INAD ("item not as described") disputes.

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS defects_found jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.grade_reports.defects_found IS
  'Structured GENUINE wear/damage the AI grader identified (array of '
  '{defect, severity, location, impact_on_grade}). Intentional design features '
  'live in detected_style_attributes, NOT here. Powers the Auto-Disclosure '
  'Engine (condition & flaws section + annotated defect photos).';

-- Historical rows can't be backfilled (the structured list was never stored);
-- they default to an empty array and the disclosure engine reads the legacy
-- detailed_notes.defects_summary as a fallback for those.
