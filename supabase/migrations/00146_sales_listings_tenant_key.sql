-- US-410: denormalize the owning user_id onto listings/sales for index-backed
-- per-tenant reporting.
--
-- sales and listings had NO tenant key (audit 2026-06-03): every per-user
-- finances/analytics query — and every RLS check — reached the owner by joining
-- inventory_items, so Postgres scanned-then-joined across tenants instead of
-- seeking an index. This:
--   1. adds user_id to both tables (FK to users, ON DELETE CASCADE like the
--      parent item), backfilled from inventory_items,
--   2. keeps it in sync with a BEFORE trigger that derives it from
--      inventory_item_id (so it can never drift from the parent's owner),
--   3. adds the composite indexes the reporting queries sort/filter on:
--      (user_id, sale_date DESC) and (user_id, listing_status),
--   4. rewrites the listings/sales RLS to filter the denormalized column
--      directly — dropping the per-row inventory_items sub-join while preserving
--      the exact owner + workspace-member semantics from 00002 / 00042.

-- ── 1. Columns (nullable first so the backfill can run) ──────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE CASCADE;

-- ── 2. Backfill from the parent inventory item ──────────────────────────────
-- inventory_item_id is NOT NULL with ON DELETE CASCADE on both tables, so there
-- are no orphans: every existing row gets a user_id here.
UPDATE public.listings l
  SET user_id = i.user_id
  FROM public.inventory_items i
  WHERE i.id = l.inventory_item_id AND l.user_id IS NULL;
UPDATE public.sales s
  SET user_id = i.user_id
  FROM public.inventory_items i
  WHERE i.id = s.inventory_item_id AND s.user_id IS NULL;

-- ── 3. Keep-in-sync trigger ─────────────────────────────────────────────────
-- Derives user_id from inventory_item_id whenever it is missing on insert or the
-- parent item changes. SECURITY DEFINER so the lookup succeeds regardless of the
-- caller's RLS view of inventory_items; it can ONLY copy the true owner of the
-- referenced item, and the INSERT/UPDATE is still gated by the WITH CHECK policy
-- evaluated against this (post-trigger) user_id — so it cannot be used to plant a
-- row under another tenant.
CREATE OR REPLACE FUNCTION public.set_tenant_from_inventory_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id)
  THEN
    SELECT i.user_id INTO NEW.user_id
    FROM public.inventory_items i
    WHERE i.id = NEW.inventory_item_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_listings_tenant ON public.listings;
CREATE TRIGGER set_listings_tenant
  BEFORE INSERT OR UPDATE OF inventory_item_id, user_id ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.set_tenant_from_inventory_item();

DROP TRIGGER IF EXISTS set_sales_tenant ON public.sales;
CREATE TRIGGER set_sales_tenant
  BEFORE INSERT OR UPDATE OF inventory_item_id, user_id ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.set_tenant_from_inventory_item();

-- ── 4. Enforce presence now that every row is populated ─────────────────────
ALTER TABLE public.listings ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.sales    ALTER COLUMN user_id SET NOT NULL;

-- ── 5. Composite tenant indexes (match the reporting sort/filter keys) ───────
CREATE INDEX IF NOT EXISTS idx_sales_user_id_sale_date
  ON public.sales(user_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_listings_user_id_listing_status
  ON public.listings(user_id, listing_status);

-- ── 6. RLS: filter the denormalized tenant key directly ─────────────────────
-- Replaces the 00002 owner policies AND the 00042 workspace policies (both of
-- which sub-joined inventory_items) with single combined policies on the
-- denormalized column. is_workspace_member_with_role(user_id, …) already returns
-- true for the owner (auth.uid() = workspace_owner short-circuit), so one policy
-- per operation reproduces owner-OR-member access without the join.

-- listings
DROP POLICY IF EXISTS "Users can view own listings"               ON public.listings;
DROP POLICY IF EXISTS "Users can create listings"                 ON public.listings;
DROP POLICY IF EXISTS "Users can update own listings"             ON public.listings;
DROP POLICY IF EXISTS "Users can delete own listings"             ON public.listings;
DROP POLICY IF EXISTS "Workspace members can view listings"       ON public.listings;
DROP POLICY IF EXISTS "Workspace listing managers can create listings" ON public.listings;
DROP POLICY IF EXISTS "Workspace listing managers can update listings" ON public.listings;
DROP POLICY IF EXISTS "Workspace admins can delete listings"      ON public.listings;

CREATE POLICY "Tenant can view listings"
  ON public.listings FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));
CREATE POLICY "Tenant can create listings"
  ON public.listings FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));
CREATE POLICY "Tenant can update listings"
  ON public.listings FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));
CREATE POLICY "Tenant can delete listings"
  ON public.listings FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

-- sales (DELETE stays owner-only — 00042 granted no workspace delete on sales)
DROP POLICY IF EXISTS "Users can view own sales"                  ON public.sales;
DROP POLICY IF EXISTS "Users can create sales"                    ON public.sales;
DROP POLICY IF EXISTS "Users can update own sales"                ON public.sales;
DROP POLICY IF EXISTS "Users can delete own sales"                ON public.sales;
DROP POLICY IF EXISTS "Workspace members can view sales"          ON public.sales;
DROP POLICY IF EXISTS "Workspace listing managers can create sales" ON public.sales;
DROP POLICY IF EXISTS "Workspace listing managers can update sales" ON public.sales;

CREATE POLICY "Tenant can view sales"
  ON public.sales FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));
CREATE POLICY "Tenant can create sales"
  ON public.sales FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));
CREATE POLICY "Tenant can update sales"
  ON public.sales FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));
CREATE POLICY "Owner can delete sales"
  ON public.sales FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON COLUMN public.listings.user_id IS
  'US-410: denormalized owning tenant (= inventory_items.user_id), kept in sync '
  'by trigger set_listings_tenant. Index-backs per-user reporting + RLS.';
COMMENT ON COLUMN public.sales.user_id IS
  'US-410: denormalized owning tenant (= inventory_items.user_id), kept in sync '
  'by trigger set_sales_tenant. Index-backs per-user reporting + RLS.';
