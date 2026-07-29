-- US-2210: store the label transcription a grade was identified from.
--
-- Grading previously took brand/size/style from whatever the seller typed at
-- submit; lib/ai-tag-ocr.ts had been reading those fields verbatim off the
-- garment's own care label since US-543, but only the AutoLister called it. The
-- pipeline now runs that read and injects it as TRUSTED context, so the read
-- itself has to be retained: an identity claim that cannot be re-inspected is
-- not auditable, and a reviewer resolving a dispute needs to see what the label
-- actually said and how confidently it was read.
--
-- Shape (jsonb, nullable):
--   { fields: [{field, value, confidence}],   -- only reads >= min_confidence
--     discrepancies: [{field, read, declared}],
--     min_confidence, model, read_at }
--
-- NULL means the read did not happen or produced nothing usable — the feature
-- is off (GRADING_TAG_OCR, default OFF), the submission had no label photo, the
-- vision call failed, or every field fell below the confidence bar. All four are
-- the same thing downstream: no label-derived identity for this grade.
--
-- NOT exposed on the public certificate. content-public.ts CERT_REPORT_COLUMNS
-- is an explicit allowlist and this column is deliberately absent from it:
-- publishing a machine read of a garment's tag as certified identity is a
-- product decision that waits for the eval numbers.
--
-- Risk: LOW. One additive nullable jsonb column, no backfill, no index, no
-- trigger, no view change. Idempotent and re-run safe.

alter table public.grade_reports
  add column if not exists tag_read jsonb;

comment on column public.grade_reports.tag_read is
  'US-2210 verbatim care/brand-label transcription used to identify this grade: {fields:[{field,value,confidence}], discrepancies:[{field,read,declared}], min_confidence, model, read_at}. NULL = no label-derived identity (feature off, no label photo, read failed, or nothing cleared the confidence bar). Internal — NOT in the public certificate column allowlist.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00496') on conflict do nothing;
