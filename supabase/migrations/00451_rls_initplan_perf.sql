-- US-1927: RLS policies re-evaluate auth.uid() / the workspace-member helper
-- per candidate row on large per-user reads.
--
-- Two related planner findings from the 2026-07-11 code-review sweep:
--
--   FINDING 1 — correlated-subquery child tables. submission_images,
--   grade_reports, item_photos and shipments gate access through an
--   `EXISTS (SELECT 1 FROM parent WHERE parent.id = child.fk AND
--   parent.user_id = auth.uid())`. Because `auth.uid()` is a volatile-looking
--   call inside a correlated subquery, the planner re-runs the whole subquery
--   for every candidate row instead of hoisting the caller identity once.
--
--   FINDING 2 — the workspace-member helper callers. listings / sales /
--   inventory_items (and the submissions parent) call
--   `is_workspace_member_with_role(user_id, …)`, a SECURITY DEFINER function.
--   SECURITY DEFINER functions are NOT inlined, so the planner must CALL the
--   function for every candidate row; its STABLE caching only collapses
--   same-`user_id` calls, so a cross-tenant scan re-invokes it (and its
--   workspace_members lookup) per distinct owner.
--
-- The fix is the Supabase-recommended initplan form
-- (supabase-postgres-best-practices › security-rls-performance):
--
--   • Wrap `auth.uid()` as `(select auth.uid())` so the planner hoists it to a
--     single initplan constant evaluated once per statement, not once per row.
--   • Give every helper-based policy a cheap owner fast-path disjunct
--     `(select auth.uid()) = <owner col> OR is_workspace_member…(…)`. The
--     helper ALREADY returns true for the owner (its first OR branch), so this
--     is semantically redundant — but it lets the planner satisfy the common
--     single-tenant scan with the initplan comparison and NEVER call the
--     SECURITY DEFINER function for owner rows. Set membership is unchanged.
--   • A covering index on workspace_members(owner_id, member_id, role) backs
--     the helper's EXISTS lookup for the genuine cross-tenant (member) case.
--
-- SEMANTICS ARE PRESERVED EXACTLY. `(select auth.uid())` returns the identical
-- single value as `auth.uid()`; the added owner disjunct is already implied by
-- the helper. Tenant isolation (US-268) is unchanged — this is a pure planner
-- optimization. Idempotent: CREATE POLICY has no OR REPLACE, so every policy is
-- DROP-then-CREATE, and functions/indexes use OR REPLACE / IF NOT EXISTS.

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Workspace-member helper: explicit initplan form + owner short-circuit
-- ════════════════════════════════════════════════════════════════════════════
-- The owner check is already the first OR branch, so the workspace_members
-- lookup is skipped for the owner (OR short-circuit). Wrapping auth.uid() as a
-- scalar subquery keeps the identity a single initplan value.

CREATE OR REPLACE FUNCTION public.is_workspace_member_with_role(
  workspace_owner uuid,
  min_role public.workspace_role DEFAULT 'viewer'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (select auth.uid()) = workspace_owner
    OR EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE owner_id = workspace_owner
        AND member_id = (select auth.uid())
        AND public.workspace_role_rank(role) >= public.workspace_role_rank(min_role)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_member(workspace_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (select auth.uid()) = workspace_owner
    OR EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE owner_id = workspace_owner
        AND member_id = (select auth.uid())
    );
$$;

-- Covering index for the helper's EXISTS lookup (owner_id + member_id + role).
-- UNIQUE(owner_id, member_id) already indexes the first two columns; adding role
-- lets the role-rank comparison be answered index-only for the member case.
CREATE INDEX IF NOT EXISTS idx_workspace_members_owner_member_role
  ON public.workspace_members (owner_id, member_id, role);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. submissions (direct user_id — parent of the grading hot path)
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can view own submissions" ON public.submissions;
CREATE POLICY "Users can view own submissions"
  ON public.submissions FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create submissions" ON public.submissions;
CREATE POLICY "Users can create submissions"
  ON public.submissions FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own submissions" ON public.submissions;
CREATE POLICY "Users can update own submissions"
  ON public.submissions FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Workspace members can view submissions" ON public.submissions;
CREATE POLICY "Workspace members can view submissions"
  ON public.submissions FOR SELECT
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'viewer')
  );

DROP POLICY IF EXISTS "Workspace members can create submissions" ON public.submissions;
CREATE POLICY "Workspace members can create submissions"
  ON public.submissions FOR INSERT
  WITH CHECK (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'member')
  );

DROP POLICY IF EXISTS "Workspace listing managers can update submissions" ON public.submissions;
CREATE POLICY "Workspace listing managers can update submissions"
  ON public.submissions FOR UPDATE
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'listing_manager')
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 2. submission_images (correlated via submissions)
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can view own submission images" ON public.submission_images;
CREATE POLICY "Users can view own submission images"
  ON public.submission_images FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions
      WHERE submissions.id = submission_images.submission_id
        AND submissions.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can create submission images" ON public.submission_images;
CREATE POLICY "Users can create submission images"
  ON public.submission_images FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.submissions
      WHERE submissions.id = submission_images.submission_id
        AND submissions.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Workspace members can view submission images" ON public.submission_images;
CREATE POLICY "Workspace members can view submission images"
  ON public.submission_images FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = submission_images.submission_id
        AND ((select auth.uid()) = s.user_id OR public.is_workspace_member(s.user_id))
    )
  );

DROP POLICY IF EXISTS "Workspace members can create submission images" ON public.submission_images;
CREATE POLICY "Workspace members can create submission images"
  ON public.submission_images FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = submission_images.submission_id
        AND ((select auth.uid()) = s.user_id OR public.is_workspace_member_with_role(s.user_id, 'member'))
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 3. grade_reports (correlated via submissions)
-- ════════════════════════════════════════════════════════════════════════════
-- NB: "Public can view grade reports with certificates" (certificate_id IS NOT
-- NULL) and "Admins can view all grade reports" (is_admin()) are left unchanged.
DROP POLICY IF EXISTS "Users can view own grade reports" ON public.grade_reports;
CREATE POLICY "Users can view own grade reports"
  ON public.grade_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions
      WHERE submissions.id = grade_reports.submission_id
        AND submissions.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Workspace members can view grade reports" ON public.grade_reports;
CREATE POLICY "Workspace members can view grade reports"
  ON public.grade_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = grade_reports.submission_id
        AND ((select auth.uid()) = s.user_id OR public.is_workspace_member(s.user_id))
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 4. inventory_items (direct user_id — parent of the FlipDesk hot path)
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can view own inventory items" ON public.inventory_items;
CREATE POLICY "Users can view own inventory items"
  ON public.inventory_items FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create inventory items" ON public.inventory_items;
CREATE POLICY "Users can create inventory items"
  ON public.inventory_items FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own inventory items" ON public.inventory_items;
CREATE POLICY "Users can update own inventory items"
  ON public.inventory_items FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own inventory items" ON public.inventory_items;
CREATE POLICY "Users can delete own inventory items"
  ON public.inventory_items FOR DELETE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Workspace members can view inventory" ON public.inventory_items;
CREATE POLICY "Workspace members can view inventory"
  ON public.inventory_items FOR SELECT
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'viewer')
  );

DROP POLICY IF EXISTS "Workspace listing managers can create inventory" ON public.inventory_items;
CREATE POLICY "Workspace listing managers can create inventory"
  ON public.inventory_items FOR INSERT
  WITH CHECK (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'listing_manager')
  );

DROP POLICY IF EXISTS "Workspace listing managers can update inventory" ON public.inventory_items;
CREATE POLICY "Workspace listing managers can update inventory"
  ON public.inventory_items FOR UPDATE
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'listing_manager')
  );

DROP POLICY IF EXISTS "Workspace admins can delete inventory" ON public.inventory_items;
CREATE POLICY "Workspace admins can delete inventory"
  ON public.inventory_items FOR DELETE
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'admin')
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 5. listings / sales (US-410 denormalized user_id via helper — 00146)
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Tenant can view listings" ON public.listings;
CREATE POLICY "Tenant can view listings"
  ON public.listings FOR SELECT
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'viewer')
  );

DROP POLICY IF EXISTS "Tenant can create listings" ON public.listings;
CREATE POLICY "Tenant can create listings"
  ON public.listings FOR INSERT
  WITH CHECK (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'listing_manager')
  );

DROP POLICY IF EXISTS "Tenant can update listings" ON public.listings;
CREATE POLICY "Tenant can update listings"
  ON public.listings FOR UPDATE
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'listing_manager')
  );

DROP POLICY IF EXISTS "Tenant can delete listings" ON public.listings;
CREATE POLICY "Tenant can delete listings"
  ON public.listings FOR DELETE
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'admin')
  );

DROP POLICY IF EXISTS "Tenant can view sales" ON public.sales;
CREATE POLICY "Tenant can view sales"
  ON public.sales FOR SELECT
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'viewer')
  );

DROP POLICY IF EXISTS "Tenant can create sales" ON public.sales;
CREATE POLICY "Tenant can create sales"
  ON public.sales FOR INSERT
  WITH CHECK (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'listing_manager')
  );

DROP POLICY IF EXISTS "Tenant can update sales" ON public.sales;
CREATE POLICY "Tenant can update sales"
  ON public.sales FOR UPDATE
  USING (
    (select auth.uid()) = user_id
    OR public.is_workspace_member_with_role(user_id, 'listing_manager')
  );

DROP POLICY IF EXISTS "Owner can delete sales" ON public.sales;
CREATE POLICY "Owner can delete sales"
  ON public.sales FOR DELETE
  USING ((select auth.uid()) = user_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. shipments (correlated via sales → inventory_items)
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can view own shipments" ON public.shipments;
CREATE POLICY "Users can view own shipments"
  ON public.shipments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can create shipments" ON public.shipments;
CREATE POLICY "Users can create shipments"
  ON public.shipments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can update own shipments" ON public.shipments;
CREATE POLICY "Users can update own shipments"
  ON public.shipments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can delete own shipments" ON public.shipments;
CREATE POLICY "Users can delete own shipments"
  ON public.shipments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.sales
      JOIN public.inventory_items ON inventory_items.id = sales.inventory_item_id
      WHERE sales.id = shipments.sale_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Workspace members can view shipments" ON public.shipments;
CREATE POLICY "Workspace members can view shipments"
  ON public.shipments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
      WHERE s.id = shipments.sale_id
        AND ((select auth.uid()) = i.user_id OR public.is_workspace_member(i.user_id))
    )
  );

DROP POLICY IF EXISTS "Workspace listing managers can manage shipments" ON public.shipments;
CREATE POLICY "Workspace listing managers can manage shipments"
  ON public.shipments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
      WHERE s.id = shipments.sale_id
        AND ((select auth.uid()) = i.user_id OR public.is_workspace_member_with_role(i.user_id, 'listing_manager'))
    )
  );

DROP POLICY IF EXISTS "Workspace listing managers can update shipments" ON public.shipments;
CREATE POLICY "Workspace listing managers can update shipments"
  ON public.shipments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
      WHERE s.id = shipments.sale_id
        AND ((select auth.uid()) = i.user_id OR public.is_workspace_member_with_role(i.user_id, 'listing_manager'))
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 7. item_photos (correlated via inventory_items)
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can view own item photos" ON public.item_photos;
CREATE POLICY "Users can view own item photos"
  ON public.item_photos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can create item photos" ON public.item_photos;
CREATE POLICY "Users can create item photos"
  ON public.item_photos FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can update own item photos" ON public.item_photos;
CREATE POLICY "Users can update own item photos"
  ON public.item_photos FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can delete own item photos" ON public.item_photos;
CREATE POLICY "Users can delete own item photos"
  ON public.item_photos FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items
      WHERE inventory_items.id = item_photos.inventory_item_id
        AND inventory_items.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Workspace members can view item photos" ON public.item_photos;
CREATE POLICY "Workspace members can view item photos"
  ON public.item_photos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND ((select auth.uid()) = i.user_id OR public.is_workspace_member(i.user_id))
    )
  );

DROP POLICY IF EXISTS "Workspace listing managers can manage item photos" ON public.item_photos;
CREATE POLICY "Workspace listing managers can manage item photos"
  ON public.item_photos FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND ((select auth.uid()) = i.user_id OR public.is_workspace_member_with_role(i.user_id, 'listing_manager'))
    )
  );

DROP POLICY IF EXISTS "Workspace listing managers can update item photos" ON public.item_photos;
CREATE POLICY "Workspace listing managers can update item photos"
  ON public.item_photos FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND ((select auth.uid()) = i.user_id OR public.is_workspace_member_with_role(i.user_id, 'listing_manager'))
    )
  );

DROP POLICY IF EXISTS "Workspace listing managers can delete item photos" ON public.item_photos;
CREATE POLICY "Workspace listing managers can delete item photos"
  ON public.item_photos FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND ((select auth.uid()) = i.user_id OR public.is_workspace_member_with_role(i.user_id, 'listing_manager'))
    )
  );

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00451') on conflict do nothing;
