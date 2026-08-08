-- US-2432: record WHICH prompt surface produced a grade, not just which system prompt.
--
-- grade_reports.prompt_version has always named the composite SYSTEM prompt plus
-- a suffix per dynamic block (+baseline, +fabric, +visual, +tag, +cat2). Those
-- suffixes record that a block was PRESENT. They say nothing about the content
-- it held, and everything assembled into the USER message -- the garment-type
-- and category criteria, the response schema, the Rules block, the factor-weights
-- sentence -- is outside any version string entirely.
--
-- So editing FABRIC_CRITERIA changed live grading and left every affected row
-- reporting the same prompt_version as the rows before it. This column splits
-- those eras: an 8-hex FNV-1a digest over the assembled user message, computed
-- from fixed probes, so two grades sharing a hash ran the same compiled surface.
--
-- NULLABLE on purpose. Every historical row predates the digest and there is no
-- honest backfill: the surface those grades ran under is not recoverable from
-- the row, and stamping today's hash on them would assert an era they never had.
-- NULL means "unknown", which is the truth.
--
-- Rationale and the versioned-vs-not split: vault/20-domain/grading-prompt-channels.md

ALTER TABLE public.grade_reports
  ADD COLUMN IF NOT EXISTS prompt_surface_hash text;

-- DELIBERATELY NO INDEX. The draft of this migration carried a partial btree on
-- the non-null rows, which was the wrong trade: a non-CONCURRENT CREATE INDEX
-- takes a SHARE lock and scans all of grade_reports, and a partial WHERE limits
-- what is STORED, not what is SCANNED. So it would block new grade inserts --
-- paid work -- for the length of a full-table scan.
--
-- Bought with that: a rarely-run ad-hoc analysis query. Partitioning grades by
-- prompt surface is a regression hunt, done occasionally by an operator, always
-- alongside a created_at or prompt_version filter that an existing index already
-- serves. Add the index when a query is actually slow, CONCURRENTLY, and outside
-- a transaction -- not on the chance that one day one might be.

COMMENT ON COLUMN public.grade_reports.prompt_surface_hash IS
  'US-2432: 8-hex digest of the assembled USER-message prompt surface (unversionedPromptSurfaceHash in ai-grading.ts). prompt_version covers the system prompt and block PRESENCE; this covers block CONTENT. NULL on every row graded before 2026-08-08 and on any grade whose composite predates the stamp -- absent means unknown, never "the current surface".';

insert into public.applied_migrations (version) values ('00562') on conflict do nothing;
