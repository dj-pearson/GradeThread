-- Multiple eBay account connections (US-671). The schema already permits more
-- than one marketplace_connections row per (user_id, marketplace) as long as the
-- account_handle differs (UNIQUE (user_id, marketplace, account_handle) in
-- 00008), so distinct eBay stores already coexist. What was missing:
--   1. a human label so the user can tell two stores apart, and
--   2. a way to SELECT which connection sync/publish operate against.
--
-- We add an `is_primary` flag (the "active"/selected connection). The edge
-- token resolver (getUserAccessToken) orders by is_primary first, so all authed
-- eBay calls (publish, sync, comps, policies) run against the selected account
-- without threading a connectionId through every call site. Exactly one primary
-- per (user_id, marketplace) is enforced by a partial unique index.

ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

-- At most one primary connection per owner per marketplace. Existing rows
-- default to false; getUserAccessToken falls back to most-recently-updated when
-- no primary is set, so single-connection users are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_connections_one_primary
  ON public.marketplace_connections(user_id, marketplace)
  WHERE is_primary;
