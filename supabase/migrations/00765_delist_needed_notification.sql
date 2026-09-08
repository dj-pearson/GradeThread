-- US-3144: the seller's phone learns a sold item still has listings live.
--
-- When a cross-listed item sells, its siblings on Poshmark/Mercari/Grailed/
-- Vinted/Facebook can only be ended from the seller's own browser. US-3141
-- queues that work and US-3142 wakes the desktop for it — but a seller whose
-- laptop is shut is told nothing, and the queue row expires after a week.
--
-- Its own type rather than sale_recorded, because it asks for something. A
-- notification the seller must ACT on cannot arrive under a category whose copy
-- promises "an item sold": that is US-2560's lesson, where routing a new event
-- into an existing category would have delivered a message the category's own
-- sentence did not promise.
--
-- DEPLOY ORDER MATTERS ONE WAY ONLY, exactly as in 00601. The edge INSERTS this
-- value (notifyUser, from lib/cross-listings.ts). On a database without it the
-- insert fails with 22P02 and the notice is lost, so this migration must land
-- before the edge deploys — enforced by the schema-version boot guard, since
-- EXPECTED_SCHEMA_VERSION moves to 00765 in the same commit. Nothing FILTERS on
-- the value, so a database that has it while an older edge runs is a no-op.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'delist_needed';

insert into public.applied_migrations (version) values ('00765') on conflict do nothing;
