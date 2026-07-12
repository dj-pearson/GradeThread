-- US-1518 follow-up: terminal marker for the thumbnail-backfill cron.
--
-- routes/jobs-thumbnail-backfill.ts selects `thumbnail_url IS NULL` item_photos
-- rows and downloads each source object to generate a 320px thumbnail. When the
-- source object is permanently gone — deleted out-of-band or never landed from a
-- partial upload — downloadItemPhoto 404s in BOTH buckets, the row keeps its NULL
-- thumbnail, and it is re-selected and retried on EVERY run forever (constant log
-- noise + wasted batch slots, and starvation risk once orphans reach BATCH_LIMIT).
--
-- This adds a nullable timestamp the job stamps on a confirmed "object not found"
-- so the query skips it thereafter. Additive + nullable: healthy rows are
-- untouched, and an operator can null the column to retry after a storage repair.

alter table public.item_photos
  add column if not exists thumbnail_backfill_failed_at timestamptz;

comment on column public.item_photos.thumbnail_backfill_failed_at is
  'US-1518 follow-up: set by jobs-thumbnail-backfill when the source object is '
  'permanently missing (404 in both buckets). Excludes the row from future '
  'backfill runs so a dead pointer is not retried forever. Null it to retry.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00434') ON CONFLICT DO NOTHING;
