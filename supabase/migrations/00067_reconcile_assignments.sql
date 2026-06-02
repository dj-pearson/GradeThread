-- Photo Dump Reconciliation: persist manual cluster edits (RC-006 / US-284)
--
-- Manual merge/split/move edits and the chosen time-gap threshold need to
-- survive a page reload. Until clusters are committed to the pipeline (US-287)
-- the photos themselves are still browser-side blobs, so we persist a lightweight
-- assignment SNAPSHOT on the session: an array of
--   { id, capturedAt, name, clusterId, manual }
-- plus the slider value. On reload the page restores the grouping structure
-- (and re-binds thumbnails as the same files are re-dropped / re-fetched).

ALTER TABLE public.flipdesk_reconcile_sessions
  ADD COLUMN IF NOT EXISTS assignments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.flipdesk_reconcile_sessions
  ADD COLUMN IF NOT EXISTS gap_seconds integer NOT NULL DEFAULT 30;
