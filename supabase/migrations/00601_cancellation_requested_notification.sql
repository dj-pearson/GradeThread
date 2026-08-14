-- US-2560: a buyer cancellation reaches no notification channel.
--
-- searchCancellations() has been in ebay-postorder.ts since the Post-sale page
-- shipped, and no source in marketplace-event-poll.ts read it. So of the four
-- eBay post-order cases a seller can be handed, three notified and this one did
-- not: the only way to learn a buyer had asked to cancel was to open the page
-- and look, while eBay ran its own clock and closed the request without you.
--
-- One new notification_type value. ADD VALUE IF NOT EXISTS is idempotent and
-- safe outside a transaction; the value cannot be USED in the same transaction
-- that adds it, which is fine here because nothing in this file references it.
--
-- DEPLOY ORDER MATTERS ONE WAY ONLY. The edge INSERTS this value (notifyUser,
-- via marketplace-event-notify.ts). On a database without it the insert fails
-- with 22P02 and the notification is lost, so this migration must land before
-- the edge deploys — which the schema-version boot guard enforces, since
-- EXPECTED_SCHEMA_VERSION moves to 00601 in the same commit. Nothing FILTERS on
-- the value, so a database that has it while an older edge runs is a no-op.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cancellation_requested';

insert into public.applied_migrations (version) values ('00601') on conflict do nothing;
