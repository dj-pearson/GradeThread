-- US-1763: walk-around VIDEO grading — persist the uploaded clip's reference on
-- the submission so the follow-on frame-extraction story (US-1764) can find it.
--
-- The video bytes live in the private `submission-images` bucket under the same
-- per-user folder + RLS as the garment photos (owner/submission path). These
-- columns record where + what was stored; duration is the best-effort value
-- parsed at upload (null when the container's moov/Info wasn't in the head).
-- All nullable — a submission without a video is the norm.

alter table public.submissions
  add column if not exists video_storage_path text;

alter table public.submissions
  add column if not exists video_content_type text;

alter table public.submissions
  add column if not exists video_duration_seconds numeric;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00441') ON CONFLICT DO NOTHING;
