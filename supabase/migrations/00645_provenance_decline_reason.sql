-- US-2779: why a run offered nothing.
--
-- identification_provenance keeps what was offered and what was ruled, and the
-- one thing it cannot express is the difference between a visual pass that was
-- never called and one that was called and came back empty. Both store
-- visual_candidates = '[]', which reads as the same finding and is not: the
-- first is a gate doing its job, the second is eBay having no inventory that
-- looks like this garment, and they have different fixes.
--
-- The values are runVisualPass's own decline reasons, plus NULL for a run that
-- produced candidates.

ALTER TABLE public.identification_provenance
  ADD COLUMN IF NOT EXISTS visual_declined text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'identification_provenance_visual_declined_check'
  ) THEN
    ALTER TABLE public.identification_provenance
      ADD CONSTRAINT identification_provenance_visual_declined_check
      CHECK (visual_declined IN
        ('disabled', 'no_image', 'role_not_identifying', 'no_matches', 'error'));
  END IF;
END $$;

-- "How often does the pass decline, and for which reason" — the measurement
-- query behind the operator report. Partial: a row that produced candidates
-- has a NULL here and is not part of that population.
CREATE INDEX IF NOT EXISTS idx_ident_provenance_declined
  ON public.identification_provenance (visual_declined, created_at DESC)
  WHERE visual_declined IS NOT NULL;

insert into public.applied_migrations (version) values ('00645') on conflict do nothing;
