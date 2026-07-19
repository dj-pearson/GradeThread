-- US-2142: record the authenticity verdict on the garment passport ledger.
--
-- The passport is the append-only chain of custody; the brand-authenticity
-- verdict belongs in it for the same reason 'graded' does — it is something we
-- determined about the garment at a point in time, and a later assessment should
-- supersede it without erasing the earlier one.
--
-- Only the COARSE verdict is written (see the edge writer). Red flags and
-- per-tell findings stay operator-side, matching what the public certificate
-- projects.

DO $$ BEGIN
  ALTER TYPE public.garment_event_type ADD VALUE IF NOT EXISTS 'authenticity_assessed';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00488') on conflict do nothing;
