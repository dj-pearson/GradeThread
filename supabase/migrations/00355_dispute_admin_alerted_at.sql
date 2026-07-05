-- US-1652: dispute-filed admin-alert dedup.
--
-- POST /api/notifications/dispute-filed emails + in-app-notifies the platform
-- admins when a seller files a dispute. The lookup is already owner-scoped
-- (US-1638), but nothing stopped the OWNER re-POSTing for their own still-open
-- dispute and re-firing the admin alert each time. This column is the dedup
-- gate: the handler claims it with a race-safe conditional UPDATE
-- (WHERE admin_alerted_at IS NULL) so the alert fires at most once per dispute.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); no backfill needed — a NULL means
-- "never alerted", which is correct for every existing open dispute (a re-file
-- would simply send one more alert, then latch).

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS admin_alerted_at timestamptz;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00355') ON CONFLICT DO NOTHING;
