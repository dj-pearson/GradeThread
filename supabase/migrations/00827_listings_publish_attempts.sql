-- listings.publish_attempts: count scheduled-publish tries so a broken draft
-- stops retrying.
--
-- The eBay publish-due tick (flipdesk-ebay.ts) reclaims a due draft whose
-- claim is older than 10 minutes. On failure it writes publish_error and
-- publish_failed_at but leaves scheduled_publish_at in place, so a draft with
-- a permanent blocker (a missing aspect, a revoked token) is tried about 144
-- times a day, each one spending eBay API calls. This column is what the edge
-- increments on every claim and caps on; the edge change ships separately and
-- reads exactly this name.
--
-- Column only. NOT NULL DEFAULT 0 is a metadata-only change on Postgres 11+,
-- so existing rows read 0 without a table rewrite. Idempotent.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.listings.publish_attempts IS
  'Scheduled-publish tries for this draft. The publish-due tick increments it on each claim and stops claiming at the cap, so a draft with a permanent blocker stops retrying.';

insert into public.applied_migrations (version) values ('00827') on conflict do nothing;
