-- US-2886: a per-workspace roster of PEOPLE who source inventory, so
-- `inventory_items.sourced_by` stops being free text.
--
-- `sourced_by` stays a text column on purpose: iOS, Android, the CSV importer,
-- the Google Sheets projection and every historical row already carry a name
-- string, and turning it into a FK would break all of them. This table is the
-- PICKER's roster, not a new foreign key — the UI writes the chosen row's
-- `name` into `sourced_by` exactly as it did before.
--
-- The roster the UI shows is the union of two things:
--   1. the workspace's real users (owner + workspace_members), merged in
--      client-side so a new teammate appears without a write here, and
--   2. the rows in this table — people who are NOT users (a spouse, a picker,
--      "Joint"), added on the spot from the composer or from the Sources page.
-- `member_user_id` links a roster row back to a real user when the two are the
-- same person, so renaming stays possible without duplicating them.
--
-- Idempotent (US-1108): IF NOT EXISTS everywhere, DROP POLICY before CREATE,
-- self-record footer.

CREATE TABLE IF NOT EXISTS public.sourcers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  member_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sourcers IS
  'US-2886: per-workspace roster of people who source inventory. Feeds the "Sourced by" picker; inventory_items.sourced_by still stores the NAME as text.';
COMMENT ON COLUMN public.sourcers.user_id IS
  'Workspace owner id (the tenant key), matching the sources/inventory_items convention.';
COMMENT ON COLUMN public.sourcers.member_user_id IS
  'The real user this roster entry IS, when it is one. NULL for non-user people (spouse, picker, "Joint").';
COMMENT ON COLUMN public.sourcers.archived_at IS
  'When set, hidden from the pickers. Historical inventory_items.sourced_by text is untouched.';

CREATE INDEX IF NOT EXISTS idx_sourcers_user_id ON public.sourcers(user_id);

CREATE INDEX IF NOT EXISTS idx_sourcers_active
  ON public.sourcers(user_id) WHERE archived_at IS NULL;

-- One name per workspace, case-insensitively: the whole point is that "dan",
-- "Dan" and "DAN" stop being three different sourcers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sourcers_user_name_ci
  ON public.sourcers(user_id, lower(name));

-- One roster row per linked user per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sourcers_user_member
  ON public.sourcers(user_id, member_user_id) WHERE member_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_sourcers_updated_at ON public.sourcers;
CREATE TRIGGER set_sourcers_updated_at
  BEFORE UPDATE ON public.sourcers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sourcers ENABLE ROW LEVEL SECURITY;

-- Thresholds mirror public.sources in 00042: viewer+ reads, listing_manager+
-- writes. is_workspace_member_with_role() returns true for the owner too.
DROP POLICY IF EXISTS "Workspace members can view sourcers" ON public.sourcers;
CREATE POLICY "Workspace members can view sourcers"
  ON public.sourcers FOR SELECT
  USING (public.is_workspace_member_with_role(user_id, 'viewer'));

DROP POLICY IF EXISTS "Workspace listing managers can create sourcers" ON public.sourcers;
CREATE POLICY "Workspace listing managers can create sourcers"
  ON public.sourcers FOR INSERT
  WITH CHECK (public.is_workspace_member_with_role(user_id, 'listing_manager'));

DROP POLICY IF EXISTS "Workspace listing managers can update sourcers" ON public.sourcers;
CREATE POLICY "Workspace listing managers can update sourcers"
  ON public.sourcers FOR UPDATE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

DROP POLICY IF EXISTS "Workspace listing managers can delete sourcers" ON public.sourcers;
CREATE POLICY "Workspace listing managers can delete sourcers"
  ON public.sourcers FOR DELETE
  USING (public.is_workspace_member_with_role(user_id, 'listing_manager'));

-- ══════════════════════════════════════════════════════════
-- ROSTER MAINTENANCE
-- ══════════════════════════════════════════════════════════

-- The name shown for a real user: their profile name, else the local part of
-- their email, so a roster entry is never blank.
CREATE OR REPLACE FUNCTION public.sourcer_display_name(p_full_name text, p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(btrim(COALESCE(p_full_name, '')), ''),
    NULLIF(split_part(COALESCE(p_email, ''), '@', 1), ''),
    'Teammate'
  );
$$;

-- Add (or link) one roster entry. Idempotent and conflict-proof:
--   - already linked to this user  -> nothing to do, keeps a manual rename
--   - a text-only row of the same name exists (from the sourced_by backfill)
--     -> link it to the user instead of creating a duplicate
--   - the name is taken by a DIFFERENT user -> the DO UPDATE ... WHERE skips it,
--     so this never raises inside a signup or an invite acceptance
CREATE OR REPLACE FUNCTION public.ensure_sourcer(p_owner uuid, p_member uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
BEGIN
  IF p_owner IS NULL OR v_name IS NULL THEN
    RETURN;
  END IF;

  IF p_member IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.sourcers
     WHERE user_id = p_owner AND member_user_id = p_member
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.sourcers (user_id, name, member_user_id)
  VALUES (p_owner, v_name, p_member)
  ON CONFLICT (user_id, lower(name)) DO UPDATE
     SET member_user_id = COALESCE(public.sourcers.member_user_id, EXCLUDED.member_user_id)
   WHERE public.sourcers.member_user_id IS NULL
      OR public.sourcers.member_user_id = EXCLUDED.member_user_id;
END;
$$;

-- A new account gets itself on its own roster, so "who sourced this" can be
-- answered on the very first item without setting anything up.
CREATE OR REPLACE FUNCTION public.sourcers_add_self()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.ensure_sourcer(
      NEW.id, NEW.id, public.sourcer_display_name(NEW.full_name, NEW.email)
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let roster bookkeeping fail a signup.
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sourcers_add_self_on_user ON public.users;
CREATE TRIGGER sourcers_add_self_on_user
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.sourcers_add_self();

-- A teammate joining the workspace lands on the owner's roster automatically.
CREATE OR REPLACE FUNCTION public.sourcers_add_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  BEGIN
    SELECT public.sourcer_display_name(u.full_name, u.email)
      INTO v_name
      FROM public.users u
     WHERE u.id = NEW.member_id;
    PERFORM public.ensure_sourcer(NEW.owner_id, NEW.member_id, v_name);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sourcers_add_member_on_join ON public.workspace_members;
CREATE TRIGGER sourcers_add_member_on_join
  AFTER INSERT ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.sourcers_add_member();

-- ══════════════════════════════════════════════════════════
-- BACKFILL
-- ══════════════════════════════════════════════════════════

-- 1. Every distinct sourced_by name already typed into inventory_items becomes a
-- roster row, so switching the field to a picker does not orphan names that are
-- already in use. Runs FIRST so the user rows below can link onto them.
INSERT INTO public.sourcers (user_id, name)
SELECT DISTINCT ON (i.user_id, lower(btrim(i.sourced_by)))
       i.user_id, btrim(i.sourced_by)
  FROM public.inventory_items i
 WHERE i.sourced_by IS NOT NULL
   AND btrim(i.sourced_by) <> ''
 ORDER BY i.user_id, lower(btrim(i.sourced_by)), i.created_at
ON CONFLICT DO NOTHING;

-- 2. Existing accounts get themselves.
SELECT public.ensure_sourcer(u.id, u.id, public.sourcer_display_name(u.full_name, u.email))
  FROM public.users u;

-- 3. Existing workspace members get added to their owner's roster.
SELECT public.ensure_sourcer(m.owner_id, m.member_id,
                             public.sourcer_display_name(u.full_name, u.email))
  FROM public.workspace_members m
  JOIN public.users u ON u.id = m.member_id;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00672')
ON CONFLICT (version) DO NOTHING;
