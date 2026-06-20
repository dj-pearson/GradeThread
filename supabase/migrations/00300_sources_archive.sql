-- US-814: archivable sourcing locations.
--
-- The iOS Sources management surface (and, in time, the web equivalent) needs a
-- way to retire a source that's no longer used WITHOUT deleting it — deleting a
-- source SET NULLs `inventory_items.source_id` (the FK in 00008) and so destroys
-- the per-source ROI history. Archiving instead keeps every historical item link
-- intact and merely hides the source from the intake pickers going forward.
--
-- `archived_at` doubles as the flag (NULL = active) and an audit timestamp.
--
-- Idempotent (US-1108): IF NOT EXISTS column + self-record footer.

ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN public.sources.archived_at IS
  'US-814: when set, the source is archived — historical inventory_items.source_id links are preserved but the source is hidden from intake/source pickers. NULL = active.';

-- Partial index: the common picker query lists only active sources for a user,
-- so index just the active rows to keep that lookup cheap as archived sources
-- accumulate.
CREATE INDEX IF NOT EXISTS idx_sources_active
  ON public.sources (user_id)
  WHERE archived_at IS NULL;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00300')
ON CONFLICT (version) DO NOTHING;
