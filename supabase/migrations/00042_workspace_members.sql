-- Multi-user workspaces (team support)
--
-- Tenancy model: each user's existing user_id continues to be the "workspace
-- owner" key — there's no separate workspaces table. workspace_members maps
-- (owner_id, member_id, role). RLS is additive: existing single-user policies
-- (auth.uid() = user_id) keep granting access to the owner; new policies in
-- this migration grant access to members at the appropriate role level.
--
-- Roles, low → high: viewer < member < listing_manager < admin < owner.
-- 'owner' is never stored in workspace_members; the owner is implicit (the
-- user whose user_id keys the workspace).

-- ══════════════════════════════════════════════════════════
-- ENUM
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.workspace_role AS ENUM (
  'viewer',
  'member',
  'listing_manager',
  'admin',
  'owner'
);

-- Integer rank for "at least this role" comparisons in policies.
CREATE OR REPLACE FUNCTION public.workspace_role_rank(r public.workspace_role)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE r
    WHEN 'viewer' THEN 1
    WHEN 'member' THEN 2
    WHEN 'listing_manager' THEN 3
    WHEN 'admin' THEN 4
    WHEN 'owner' THEN 5
  END;
$$;

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

CREATE TABLE public.workspace_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role        public.workspace_role NOT NULL DEFAULT 'viewer',
  invited_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, member_id),
  CHECK (owner_id <> member_id),
  CHECK (role <> 'owner')
);

CREATE INDEX idx_workspace_members_owner_id ON public.workspace_members(owner_id);
CREATE INDEX idx_workspace_members_member_id ON public.workspace_members(member_id);

CREATE TRIGGER set_workspace_members_updated_at
  BEFORE UPDATE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workspace_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        public.workspace_role NOT NULL DEFAULT 'viewer',
  token       text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'owner')
);

CREATE INDEX idx_workspace_invitations_owner_id ON public.workspace_invitations(owner_id);
CREATE INDEX idx_workspace_invitations_token ON public.workspace_invitations(token);
CREATE INDEX idx_workspace_invitations_email_lower ON public.workspace_invitations(lower(email));

-- Only one outstanding invite per (owner, email).
CREATE UNIQUE INDEX uniq_workspace_invitations_pending
  ON public.workspace_invitations(owner_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER set_workspace_invitations_updated_at
  BEFORE UPDATE ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Active workspace pointer on the user profile. NULL = personal workspace
-- (workspace_owner_id = id). Members can switch between workspaces they
-- belong to; their own personal workspace is always available.
ALTER TABLE public.users
  ADD COLUMN active_workspace_owner_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- ══════════════════════════════════════════════════════════
-- ACCESS HELPER
-- ══════════════════════════════════════════════════════════
--
-- Returns true if auth.uid() can act on workspace `workspace_owner` at
-- `min_role` or higher. The owner ALWAYS satisfies any role check; this is
-- intentionally not relied on by the additive policies below (which still
-- defer to existing `auth.uid() = user_id` policies for owner access), but
-- it keeps the helper usable in new code that wants a single check.

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
    auth.uid() = workspace_owner
    OR EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE owner_id = workspace_owner
        AND member_id = auth.uid()
        AND public.workspace_role_rank(role) >= public.workspace_role_rank(min_role)
    );
$$;

-- Used inside policies for indirect-scope tables (e.g. submission_images
-- joins through submissions; we need the join filter to allow members).
CREATE OR REPLACE FUNCTION public.is_workspace_member(workspace_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = workspace_owner
    OR EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE owner_id = workspace_owner
        AND member_id = auth.uid()
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_workspace_member_with_role(uuid, public.workspace_role) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.workspace_role_rank(public.workspace_role) TO authenticated, anon;

-- ══════════════════════════════════════════════════════════
-- ACCEPT INVITATION RPC
-- ══════════════════════════════════════════════════════════
--
-- Called by a logged-in user with a token from an invitation link. Validates
-- the token, matches the email against auth.users, and inserts the
-- workspace_members row. SECURITY DEFINER because the invitations table is
-- locked down to workspace owners — the invitee couldn't read it directly.
--
-- Returns the owner_id on success; raises an exception on any failure.

CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(invitation_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_user_email text;
  v_inv public.workspace_invitations%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.workspace_invitations
  WHERE token = invitation_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation already accepted' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has been revoked' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = 'P0001';
  END IF;

  IF lower(v_inv.email) <> lower(v_user_email) THEN
    RAISE EXCEPTION 'Invitation email does not match your account' USING ERRCODE = '42501';
  END IF;

  IF v_inv.owner_id = v_user_id THEN
    RAISE EXCEPTION 'You cannot invite yourself' USING ERRCODE = 'P0001';
  END IF;

  -- Upsert: if a membership row already exists, update the role to the
  -- invited role. This lets owners re-invite an existing member to change
  -- their role through the invitation flow if they want to.
  INSERT INTO public.workspace_members (owner_id, member_id, role, invited_by)
  VALUES (v_inv.owner_id, v_user_id, v_inv.role, v_inv.invited_by)
  ON CONFLICT (owner_id, member_id)
  DO UPDATE SET role = EXCLUDED.role, updated_at = now();

  UPDATE public.workspace_invitations
  SET accepted_at = now(), accepted_by = v_user_id
  WHERE id = v_inv.id;

  RETURN v_inv.owner_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation(text) TO authenticated;

-- Public peek for the accept-invite page so the invitee can see who invited
-- them and what role before clicking accept. Returns NULL if invalid/expired.
CREATE OR REPLACE FUNCTION public.peek_workspace_invitation(invitation_token text)
RETURNS TABLE (
  email text,
  role public.workspace_role,
  owner_email text,
  owner_full_name text,
  expires_at timestamptz,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    i.email,
    i.role,
    u.email AS owner_email,
    u.full_name AS owner_full_name,
    i.expires_at,
    CASE
      WHEN i.accepted_at IS NOT NULL THEN 'accepted'
      WHEN i.revoked_at IS NOT NULL THEN 'revoked'
      WHEN i.expires_at < now() THEN 'expired'
      ELSE 'pending'
    END AS status
  FROM public.workspace_invitations i
  JOIN public.users u ON u.id = i.owner_id
  WHERE i.token = invitation_token;
$$;

GRANT EXECUTE ON FUNCTION public.peek_workspace_invitation(text) TO authenticated, anon;

-- ══════════════════════════════════════════════════════════
-- RLS ON THE NEW TABLES
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;

-- workspace_members
--
-- A member can SELECT rows for any workspace they're in (so the UI can list
-- "workspaces I belong to"). The owner can manage all rows in their
-- workspace. Admins (workspace_role = 'admin') can manage rows in their
-- workspace EXCEPT they can't promote anyone above their own level.

CREATE POLICY "Members can view their own membership rows"
  ON public.workspace_members FOR SELECT
  USING (member_id = auth.uid());

CREATE POLICY "Owners can view all workspace members"
  ON public.workspace_members FOR SELECT
  USING (owner_id = auth.uid());

-- Self-referential SELECT policies on workspace_members would recurse
-- through RLS. is_workspace_member_with_role() is SECURITY DEFINER, so
-- its body bypasses RLS — safe to use here.
CREATE POLICY "Admins can view workspace members"
  ON public.workspace_members FOR SELECT
  USING (
    public.is_workspace_member_with_role(workspace_members.owner_id, 'admin')
  );

CREATE POLICY "Owners can insert workspace members"
  ON public.workspace_members FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can update workspace members"
  ON public.workspace_members FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can delete workspace members"
  ON public.workspace_members FOR DELETE
  USING (owner_id = auth.uid());

-- Members can remove themselves (leave a workspace).
CREATE POLICY "Members can leave a workspace"
  ON public.workspace_members FOR DELETE
  USING (member_id = auth.uid());

-- workspace_invitations
--
-- Owners + admins manage invitations. The accept flow runs through the
-- SECURITY DEFINER RPC above, so invitees never read this table directly.

CREATE POLICY "Owners can view their invitations"
  ON public.workspace_invitations FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY "Owners can create invitations"
  ON public.workspace_invitations FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can update their invitations"
  ON public.workspace_invitations FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can delete their invitations"
  ON public.workspace_invitations FOR DELETE
  USING (owner_id = auth.uid());

-- ══════════════════════════════════════════════════════════
-- ADDITIVE RLS ON USER-SCOPED TABLES
-- ══════════════════════════════════════════════════════════
--
-- Pattern: existing policies grant access to the owner via
-- `auth.uid() = user_id`. We add new policies that grant access to
-- workspace members at the appropriate role threshold. Postgres OR-s
-- policies of the same command together, so these are pure additions.
--
-- Permission matrix (min role required):
--   SELECT: viewer
--   INSERT (write actions): member or listing_manager (depending on table)
--   UPDATE/DELETE: listing_manager or admin
--
-- Rule of thumb:
--   - Reading: viewer
--   - Creating grade submissions / disputes: member
--   - Creating/editing inventory, listings, sources, expenses, saved views: listing_manager
--   - Marketplace OAuth, API keys, payout imports: admin
--   - Billing / subscription / credit ledger writes: owner (service-role only — no member policy needed)
--
-- Pages also flow workspace_owner_id into INSERT values so the row keys the
-- active workspace, not the member's own user_id.

-- ─── users (profile) ──────────────────────────────────────────────
-- Workspace members can read the owner's profile (to display name, plan, etc).
-- Members CANNOT update the owner's profile — only the owner can.
CREATE POLICY "Workspace members can view owner profile"
  ON public.users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE owner_id = users.id
        AND member_id = auth.uid()
    )
  );

-- Owners + admins of a workspace can view each member's profile (display).
CREATE POLICY "Workspace owners can view member profiles"
  ON public.users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE member_id = users.id
        AND owner_id = auth.uid()
    )
  );

-- ─── submissions ──────────────────────────────────────────────────
CREATE POLICY "Workspace members can view submissions"
  ON public.submissions FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

CREATE POLICY "Workspace members can create submissions"
  ON public.submissions FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'member'));

CREATE POLICY "Workspace listing managers can update submissions"
  ON public.submissions FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

-- ─── submission_images (indirect via submissions) ─────────────────
CREATE POLICY "Workspace members can view submission images"
  ON public.submission_images FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = submission_images.submission_id
        AND public.is_workspace_member(s.user_id)
    )
  );

CREATE POLICY "Workspace members can create submission images"
  ON public.submission_images FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = submission_images.submission_id
        AND public.is_workspace_member_with_role(s.user_id, 'member')
    )
  );

-- ─── grade_reports (indirect via submissions) ─────────────────────
CREATE POLICY "Workspace members can view grade reports"
  ON public.grade_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions s
      WHERE s.id = grade_reports.submission_id
        AND public.is_workspace_member(s.user_id)
    )
  );

-- ─── disputes ─────────────────────────────────────────────────────
CREATE POLICY "Workspace members can view disputes"
  ON public.disputes FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

CREATE POLICY "Workspace members can create disputes"
  ON public.disputes FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'member'));

-- ─── api_keys (admin-level — handles credentials) ─────────────────
CREATE POLICY "Workspace admins can view api keys"
  ON public.api_keys FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

CREATE POLICY "Workspace admins can create api keys"
  ON public.api_keys FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'admin'));

CREATE POLICY "Workspace admins can delete api keys"
  ON public.api_keys FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

-- ─── inventory_items ──────────────────────────────────────────────
CREATE POLICY "Workspace members can view inventory"
  ON public.inventory_items FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

CREATE POLICY "Workspace listing managers can create inventory"
  ON public.inventory_items FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace listing managers can update inventory"
  ON public.inventory_items FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace admins can delete inventory"
  ON public.inventory_items FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

-- ─── listings (indirect via inventory_items) ──────────────────────
CREATE POLICY "Workspace members can view listings"
  ON public.listings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = listings.inventory_item_id
        AND public.is_workspace_member(i.user_id)
    )
  );

CREATE POLICY "Workspace listing managers can create listings"
  ON public.listings FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = listings.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

CREATE POLICY "Workspace listing managers can update listings"
  ON public.listings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = listings.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

CREATE POLICY "Workspace admins can delete listings"
  ON public.listings FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = listings.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'admin')
    )
  );

-- ─── sales (indirect via inventory_items) ─────────────────────────
CREATE POLICY "Workspace members can view sales"
  ON public.sales FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = sales.inventory_item_id
        AND public.is_workspace_member(i.user_id)
    )
  );

CREATE POLICY "Workspace listing managers can create sales"
  ON public.sales FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = sales.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

CREATE POLICY "Workspace listing managers can update sales"
  ON public.sales FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = sales.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

-- ─── shipments (indirect via sales → inventory_items) ─────────────
CREATE POLICY "Workspace members can view shipments"
  ON public.shipments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
      WHERE s.id = shipments.sale_id
        AND public.is_workspace_member(i.user_id)
    )
  );

CREATE POLICY "Workspace listing managers can manage shipments"
  ON public.shipments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
      WHERE s.id = shipments.sale_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

CREATE POLICY "Workspace listing managers can update shipments"
  ON public.shipments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
      WHERE s.id = shipments.sale_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

-- ─── sources ──────────────────────────────────────────────────────
CREATE POLICY "Workspace members can view sources"
  ON public.sources FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

CREATE POLICY "Workspace listing managers can create sources"
  ON public.sources FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace listing managers can update sources"
  ON public.sources FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace listing managers can delete sources"
  ON public.sources FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

-- ─── item_photos (indirect via inventory_items) ───────────────────
CREATE POLICY "Workspace members can view item photos"
  ON public.item_photos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND public.is_workspace_member(i.user_id)
    )
  );

CREATE POLICY "Workspace listing managers can manage item photos"
  ON public.item_photos FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

CREATE POLICY "Workspace listing managers can update item photos"
  ON public.item_photos FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

CREATE POLICY "Workspace listing managers can delete item photos"
  ON public.item_photos FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = item_photos.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'listing_manager')
    )
  );

-- ─── marketplace_connections (admin-level — holds OAuth tokens) ───
CREATE POLICY "Workspace admins can view marketplace connections"
  ON public.marketplace_connections FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

CREATE POLICY "Workspace admins can manage marketplace connections"
  ON public.marketplace_connections FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'admin'));

CREATE POLICY "Workspace admins can update marketplace connections"
  ON public.marketplace_connections FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

CREATE POLICY "Workspace admins can delete marketplace connections"
  ON public.marketplace_connections FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

-- ─── payout_imports (admin-level — financial reconciliation) ──────
CREATE POLICY "Workspace admins can view payout imports"
  ON public.payout_imports FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

CREATE POLICY "Workspace admins can manage payout imports"
  ON public.payout_imports FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'admin'));

CREATE POLICY "Workspace admins can update payout imports"
  ON public.payout_imports FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

-- ─── flipdesk_saved_views ─────────────────────────────────────────
CREATE POLICY "Workspace members can view saved views"
  ON public.flipdesk_saved_views FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

CREATE POLICY "Workspace listing managers can manage saved views"
  ON public.flipdesk_saved_views FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace listing managers can update saved views"
  ON public.flipdesk_saved_views FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace listing managers can delete saved views"
  ON public.flipdesk_saved_views FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

-- ─── flipdesk_expenses ────────────────────────────────────────────
CREATE POLICY "Workspace members can view expenses"
  ON public.flipdesk_expenses FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

CREATE POLICY "Workspace listing managers can create expenses"
  ON public.flipdesk_expenses FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace listing managers can update expenses"
  ON public.flipdesk_expenses FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace admins can delete expenses"
  ON public.flipdesk_expenses FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'admin'));

-- ─── flipdesk_ebay_listings ───────────────────────────────────────
CREATE POLICY "Workspace members can view ebay listings"
  ON public.flipdesk_ebay_listings FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

CREATE POLICY "Workspace listing managers can manage ebay listings"
  ON public.flipdesk_ebay_listings FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));

CREATE POLICY "Workspace listing managers can update ebay listings"
  ON public.flipdesk_ebay_listings FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

-- ─── flipdesk_grading_submissions (indirect via inventory_items) ──
CREATE POLICY "Workspace members can view flipdesk grading submissions"
  ON public.flipdesk_grading_submissions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = flipdesk_grading_submissions.inventory_item_id
        AND public.is_workspace_member(i.user_id)
    )
  );

CREATE POLICY "Workspace members can create flipdesk grading submissions"
  ON public.flipdesk_grading_submissions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = flipdesk_grading_submissions.inventory_item_id
        AND public.is_workspace_member_with_role(i.user_id, 'member')
    )
  );

-- ─── notifications ────────────────────────────────────────────────
-- Notifications stay personal: each user only sees notifications addressed
-- to them. We don't extend RLS here — workspace membership doesn't grant
-- access to others' notifications. (Notifications about workspace events
-- will be fanned out per-recipient by edge function logic.)

-- ─── ai_enrichment_log ────────────────────────────────────────────
CREATE POLICY "Workspace members can view ai enrichment log"
  ON public.ai_enrichment_log FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

-- grade_credit_transactions and flipdesk_subscription_events are
-- intentionally NOT extended — they are owner-only financial records that
-- only the workspace owner should see. The existing RLS still grants the
-- owner full access.

-- ══════════════════════════════════════════════════════════
-- STORAGE: workspace members can access submission images
-- ══════════════════════════════════════════════════════════
--
-- Existing storage policies scope to (storage.foldername(name))[1] =
-- auth.uid()::text, which only lets the owner read their own folder. We
-- add an additive policy that lets workspace members read/write into the
-- workspace owner's folder.

CREATE POLICY "Workspace members can upload to owner folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'submission-images'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'member'
    )
  );

CREATE POLICY "Workspace members can view owner files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'submission-images'
    AND public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

-- Members cannot delete files — only the owner (existing policy still
-- applies) or via app-level moderation. Keeps this safer by default.

-- item-photos bucket: workspace listing managers can write into the
-- owner's folder. Public read remains via the existing policy.
CREATE POLICY "Workspace members can upload to owner item-photos folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'item-photos'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'listing_manager'
    )
  );

CREATE POLICY "Workspace members can update owner item-photos"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'item-photos'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'listing_manager'
    )
  );

CREATE POLICY "Workspace admins can delete owner item-photos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'item-photos'
    AND public.is_workspace_member_with_role(
      ((storage.foldername(name))[1])::uuid,
      'admin'
    )
  );
