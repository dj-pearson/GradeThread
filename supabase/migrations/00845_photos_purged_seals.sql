-- US-3540: say "Photos expired <date>" on a certificate, and keep its photo
-- seal verifiable after the photos are deleted.
--
-- data-retention.ts deletes submission_images rows (and the files) once a
-- submission passes the retention window. A certificate sealed at integrity v5
-- (00839) hashes the list of `${image_type}:${sha256}` built from those rows,
-- so deleting them would turn a legitimate certificate into a "mismatch" the
-- day its photos expired. The purge now moves each deleted row's seal entry
-- here first, keyed by the row id so a retried run cannot count one twice,
-- and stamps when it happened. Hashes of deleted files are not personal data.

alter table public.submissions
  add column if not exists photos_purged_at timestamptz,
  add column if not exists purged_photo_seals jsonb not null default '{}'::jsonb;

comment on column public.submissions.photos_purged_at is
  'US-3540: when data retention first deleted this submission''s photos. NULL while they exist.';
comment on column public.submissions.purged_photo_seals is
  'US-3540: {submission_images.id: "image_type:sha256"} for photos deleted by retention, so a v5 certificate seal still verifies.';

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
insert into public.applied_migrations (version) values ('00845') on conflict do nothing;
