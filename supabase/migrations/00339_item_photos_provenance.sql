-- US-1539: persist photo provenance — original filename + EXIF capture time.
--
-- AutoLister reads EXIF capture time client-side (lib/exif.ts) to drive
-- auto-grouping, then throws it away: the edge strips ALL metadata from the
-- stored bytes at /staging/upload (US-276 hardening, deliberately kept), and
-- the original filename was never persisted anywhere. So the server could
-- never reconstruct or verify a grouping decision, and filename-sequence
-- grouping (US-1540) had nothing durable to read after a reload.
--
-- Only the two SCALAR fields are kept — the image bytes stay metadata-free
-- (no GPS/EXIF lands in storage), and neither column is rendered on any
-- public listing surface.
--
-- captured_at already exists on most databases (00066, photo-dump
-- reconciliation); the IF NOT EXISTS keeps this idempotent either way.

alter table public.item_photos
  add column if not exists captured_at timestamptz;

alter table public.item_photos
  add column if not exists original_filename text;

comment on column public.item_photos.captured_at is
  'US-1539 (originally 00066): EXIF capture time read client-side BEFORE the '
  'intake metadata strip. Grouping/audit signal only — never rendered publicly.';

comment on column public.item_photos.original_filename is
  'US-1539: the source file''s original name (e.g. IMG_0551.jpg), kept so '
  'filename-sequence grouping (US-1540) and grouping audits have a durable '
  'signal. Never rendered on public listing surfaces.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00339') on conflict do nothing;
