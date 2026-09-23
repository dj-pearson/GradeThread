-- get_or_create_source: check the caller may write to p_user_id's sources.
--
-- 00640 gave this SECURITY DEFINER function a role guard (signed in, not anon)
-- and nothing else. It then trusted p_user_id from the caller, so any signed-in
-- account could look up another seller's source by name (a name probe) and
-- insert a source row into that seller's account. The browser passes
-- p_user_id itself (intake.tsx, bulk-intake.tsx), so the value is client
-- controlled. vault/20-domain/security-definer-exposure.md listed this as
-- needing "auth.uid() is not null plus tenant scoping"; only the first half
-- shipped.
--
-- The tenant check admits exactly who the sources INSERT policies admit
-- (00008 owner, 00042 workspace listing_manager and up), plus the service
-- role, which the edge uses and which carries no sub. Anyone else gets 42501.
--
-- Written as IF NOT coalesce(...) so a NULL (no JWT claims at all) refuses
-- rather than falling through: the 00640 header explains why an IF on NULL
-- fails open.
--
-- Body otherwise carried forward unchanged from 00640. Same signature, so
-- CREATE OR REPLACE replaces in place and the existing grants stand. No
-- REVOKE: a denied EXECUTE restarts this Postgres image (US-2403).

CREATE OR REPLACE FUNCTION public.get_or_create_source(
  p_user_id uuid,
  p_name text,
  p_source_type public.flipdesk_source_type DEFAULT 'other'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.gt_require_role('get_or_create_source', 'authenticated');
  IF NOT coalesce(
       auth.role() = 'service_role'
       OR p_user_id = auth.uid()
       OR public.is_workspace_member_with_role(p_user_id, 'listing_manager'),
       false) THEN
    RAISE EXCEPTION 'get_or_create_source: not authorized for this account'
      USING ERRCODE = '42501';
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_id
  FROM public.sources
  WHERE user_id = p_user_id AND lower(name) = lower(trim(p_name))
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.sources (user_id, name, source_type)
  VALUES (p_user_id, trim(p_name), p_source_type)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

insert into public.applied_migrations (version) values ('00824') on conflict do nothing;
