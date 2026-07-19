-- Grading governance: model qualification (US-2036) + golden-set soft delete (US-2037).
--
-- Numbered 00480, NOT 00479: prod's applied_migrations already records a 00479
-- that has no file in this repo (measured 2026-07-19 via /health/ready). Reusing
-- it would satisfy the boot guard off that stale row. See PENDING_MIGRATIONS.md.
--
-- US-2036: the eval gate stamped ai_prompt_versions.eval_passed with no model
-- attribution, so an env change to DEFAULT_AI_MODEL bypassed the gate entirely.
-- qualified_model records WHICH model the passing run used; activation compares
-- it against the live grading model.
--
-- US-2037: golden eval cases were hard-deletable. deleted_at makes removal
-- auditable and reversible; every read path filters deleted_at IS NULL.

ALTER TABLE public.ai_prompt_versions
  ADD COLUMN IF NOT EXISTS qualified_model text;

COMMENT ON COLUMN public.ai_prompt_versions.qualified_model IS
  'The grading model the most recent eval run used. NULL = never evaluated, or the last run failed. activatePromptVersion refuses to activate when this differs from the live grading model (US-2036).';

ALTER TABLE public.grading_eval_cases
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.grading_eval_cases.deleted_at IS
  'Soft-delete tombstone (US-2037). A removed golden case stays on the row for audit; all eval/read paths filter deleted_at IS NULL. Never hard-delete: a shrinking golden set is the signal reviewers are asked to watch for.';

-- The active-case index is the hot path for every eval run; keep it aligned
-- with the new filter so a soft-deleted case is never scanned.
DROP INDEX IF EXISTS public.idx_grading_eval_cases_active;
CREATE INDEX IF NOT EXISTS idx_grading_eval_cases_active
  ON public.grading_eval_cases(is_active)
  WHERE is_active = true AND deleted_at IS NULL;

insert into public.applied_migrations (version) values ('00480') on conflict do nothing;
