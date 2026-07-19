-- US-2007 AC3: enforce "at most ONE inventory item per submission".
--
-- The AC asked to CONFIRM the relationship before constraining it, rather than
-- assume it mirrors grade_reports. Confirmed by exhaustive search: exactly ONE
-- writer in the entire codebase sets inventory_items.submission_id —
-- flipdesk-grading.ts's bulk-submit loop — and it assigns a submission id that
-- was INSERTed inside that same iteration. Nothing copies a submission_id
-- between items; the web app never writes the column at all. So two items
-- sharing a submission is not a legitimate state, it is a corruption.
--
-- (A regrade overwrites an item's submission_id with a newer submission, which
-- leaves the OLD submission with no item pointing at it. That is fine and does
-- not affect uniqueness — the constraint is on the item side.)
--
-- Why it matters: grading-pipeline.ts reads the linked item with
-- .eq("submission_id", ...).maybeSingle(). Two rows make that PGRST116, and the
-- error was discarded — so the grade would be written but the item would never
-- receive its grade_value / grade_label / grade_report_id. Same silent shape as
-- the bug 00478 fixed on grade_reports.
--
-- ── De-dupe strategy: UNLINK the older duplicates, never delete ──────────
-- Unlike 00478's rows, the thing being de-duped here is a LINK, not paid
-- output. Nulling the stale link destroys nothing: the submission, its grade
-- report and the item's own grade_value/grade_label/grade_report_id all stay
-- exactly as they are. Keep the most recently updated item as the linked one.

UPDATE public.inventory_items AS i
SET submission_id = NULL
WHERE i.submission_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.inventory_items AS newer
    WHERE newer.submission_id = i.submission_id
      AND newer.id <> i.id
      -- "newer" = later updated_at, with id as a deterministic tie-break so a
      -- same-timestamp pair still resolves to exactly one survivor.
      AND (newer.updated_at > i.updated_at
           OR (newer.updated_at = i.updated_at AND newer.id > i.id))
  );

-- Partial: an item with no submission (never graded) is unconstrained, and
-- there are many of those, so the NULLs must not collide with each other.
--
-- Not CONCURRENTLY: it cannot run inside a transaction block, and
-- apply-prod-migrations.sh runs each file as one unit — consistent with how
-- 00478 and 00440 apply here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_submission_unique
  ON public.inventory_items (submission_id)
  WHERE submission_id IS NOT NULL;

COMMENT ON INDEX public.idx_inventory_items_submission_unique IS
  'US-2007 AC3: UNIQUE, enforcing at most one inventory item per submission. '
  'A duplicate made grading-pipeline.ts''s linked-item maybeSingle() return '
  'PGRST116, so the grade was stored but never written back onto the item.';

insert into public.applied_migrations (version) values ('00483') on conflict do nothing;
