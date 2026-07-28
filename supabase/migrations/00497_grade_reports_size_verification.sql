-- US-2213: store the size a grade was verified at, and how.
--
-- Grading accepted measurement photos (image_type measurement_chest / waist /
-- length / sleeve / inseam, 00103) from the day they were added and never used
-- them, while 170 brands of curated sizing charts sat in the same repo unread
-- by the pipeline. The size pass now runs and its result has to be retained: a
-- size on a public certificate that cannot be re-inspected is not auditable.
--
-- Shape (jsonb, nullable):
--   { size, source, confidence, gender?, rationale?,
--     disagreement?: { label, measurements } }
--
-- `source` is one of label | measurements | label_and_measurements, and it is
-- the load-bearing field: "M read off the care label" and "M inferred from a
-- flat-lay" are different claims, and a certificate that renders them
-- identically is overstating the second.
--
-- A SEPARATE COLUMN, NOT A KEY INSIDE grade_reports.tag_read (00496), and the
-- reason is a lesson this epic just wrote down. US-2212 found brand_knowledge
-- .tag_eras doing double duty — dating generations and never-changed code
-- formats in one column, because there was nowhere else to put the second kind
-- — and had to filter them apart at read time. A measurement-derived size is
-- not something the tag said; folding it into a column named `tag_read` would
-- repeat that mistake in a table we own. See
-- vault/20-domain/brands/brand-kb-negative-findings.md.
--
-- NULL means no verified size: the feature is off (GRADING_SIZE_VERIFY,
-- default OFF), the label was illegible and no measurement photos were
-- supplied, or nothing cleared the confidence bar. All are the same downstream:
-- fall back to displaying no size rather than an unverified one.
--
-- NOT exposed on the public certificate yet. content-public.ts
-- CERT_REPORT_COLUMNS is an explicit allowlist and this column is deliberately
-- absent from it — surfacing a VERIFIED vs DECLARED size distinction to buyers
-- is a product decision, not a side effect of storing the data.
--
-- Risk: LOW. One additive nullable jsonb column, no backfill, no index, no
-- trigger, no view change. Idempotent and re-run safe.

alter table public.grade_reports
  add column if not exists size_verification jsonb;

comment on column public.grade_reports.size_verification is
  'US-2213 verified garment size and its provenance: {size, source: label|measurements|label_and_measurements, confidence, gender?, rationale?, disagreement?{label,measurements}}. NULL = no verified size (feature off, no legible label and no measurement photos, or below the confidence bar). Internal — NOT in the public certificate column allowlist.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00497') on conflict do nothing;
