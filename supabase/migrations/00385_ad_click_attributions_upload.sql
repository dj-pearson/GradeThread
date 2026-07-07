-- US-1704: offline conversion import — upload-status tracking.
--
-- Adds per-row upload bookkeeping to ad_click_attributions (US-1700) so the
-- offline-conversion upload job (Google Ads ConversionUploadService) is
-- idempotent (only uploads a converted row once) and records success /
-- partial-failure per row instead of silently dropping. All additive + idempotent.

ALTER TABLE public.ad_click_attributions
  ADD COLUMN IF NOT EXISTS uploaded_at    timestamptz,
  ADD COLUMN IF NOT EXISTS upload_status  text,
  ADD COLUMN IF NOT EXISTS upload_error   text;

-- The upload job scans converted-but-not-yet-uploaded rows.
CREATE INDEX IF NOT EXISTS ad_click_attributions_upload_idx
  ON public.ad_click_attributions (platform, converted_at)
  WHERE converted_at IS NOT NULL AND uploaded_at IS NULL;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00385') on conflict do nothing;
