-- US-2550: a buyer can report a certificate, and the report lands in the queue
-- operators already drain.
--
-- The certificate page tells a buyer "Integrity check failed — do not trust this
-- certificate" and then offers them nothing to do with that. The moderation
-- queue from US-889 is the right destination: its own comment lists
-- 'user_report' as a source, the admin console already drains it, and the
-- partial unique index makes repeat reports of one certificate idempotent.
--
-- All it lacks is the subject. `moderation_content_type` covered listings and
-- photos, so this adds the third.
--
-- ENUM CAVEAT (US-1108): a value added by ALTER TYPE cannot be USED in the same
-- transaction. Nothing here uses it — the edge writes it on a later connection,
-- and the boot guard is what keeps that edge from deploying against a database
-- that predates this file.

alter type public.moderation_content_type add value if not exists 'certificate';

comment on type public.moderation_content_type is
  'What a content_moderation_flags row is about: a marketplace listing, an item '
  'photo, or (US-2550) a public grade certificate reported by a buyer. The '
  'content_id for a certificate is grade_reports.certificate_id, which is the '
  'uuid a buyer actually holds — not the internal report id.';

insert into public.applied_migrations (version) values ('00599') on conflict do nothing;
