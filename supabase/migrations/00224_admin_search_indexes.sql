-- US-901: global admin search / command palette.
--
-- The unified lookup in services/edge-functions/src/routes/admin-search.ts does
-- prefix/substring (ILIKE) matches across the operator-searchable columns. A
-- plain btree can't back a case-insensitive ILIKE, so add pg_trgm GIN indexes so
-- those lookups stay off full-table scans (AC#3). Exact lookups (primary keys,
-- certificate_id unique index, stripe_customer_id, platform_listing_id btree)
-- are already covered by existing indexes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Users: email (prefix) + full_name (substring) — the most common operator jump.
CREATE INDEX IF NOT EXISTS idx_users_email_trgm
  ON public.users USING GIN (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm
  ON public.users USING GIN (full_name gin_trgm_ops);

-- Submissions: title substring search.
CREATE INDEX IF NOT EXISTS idx_submissions_title_trgm
  ON public.submissions USING GIN (title gin_trgm_ops);

-- Inventory items: sku prefix search (the composite (user_id, sku) unique index
-- can't serve a sku-only ILIKE).
CREATE INDEX IF NOT EXISTS idx_inventory_items_sku_trgm
  ON public.inventory_items USING GIN (sku gin_trgm_ops);

-- Listings: platform_listing_id prefix search (the existing btree only serves
-- exact/case-sensitive lookups, not ILIKE).
CREATE INDEX IF NOT EXISTS idx_listings_platform_listing_id_trgm
  ON public.listings USING GIN (platform_listing_id gin_trgm_ops);

-- Sales: buyer username substring search.
CREATE INDEX IF NOT EXISTS idx_sales_buyer_username_trgm
  ON public.sales USING GIN (buyer_username gin_trgm_ops);

-- Support tickets: subject substring search.
CREATE INDEX IF NOT EXISTS idx_support_tickets_subject_trgm
  ON public.support_tickets USING GIN (subject gin_trgm_ops);
