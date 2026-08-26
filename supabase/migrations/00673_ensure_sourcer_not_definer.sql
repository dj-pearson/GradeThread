-- US-2886 follow-up: public.ensure_sourcer() must not be SECURITY DEFINER.
--
-- 00672 shipped it as SECURITY DEFINER out of habit, copying the trigger
-- functions around it. That is wrong here and `security-definer-grants.test.ts`
-- (US-2282) is right to fail on it: a callable SECURITY DEFINER function that
-- states nothing about who may execute it inherits Supabase's ALTER DEFAULT
-- PRIVILEGES grant to anon and authenticated. Any signed-in session could have
-- POSTed to it and written a roster row into ANOTHER workspace, because the
-- definer context bypasses the RLS on public.sourcers that is the only thing
-- scoping that insert.
--
-- Granting it to service_role instead would satisfy the guard and leave the
-- hole: the default grants are DIRECT, so nothing short of a REVOKE removes
-- them, and a REVOKE on a public function is the US-2403 segfault. Taking the
-- definer flag off is the fix that actually closes it. As SECURITY INVOKER the
-- function is subject to the same RLS as any other client write, so the worst a
-- direct call can do is add a name to a workspace the caller already manages.
--
-- The two triggers are unaffected. They stay SECURITY DEFINER (a trigger
-- function's EXECUTE is never consulted, so they are exempt by shape), and a
-- SECURITY INVOKER function called from inside one still runs as the definer.
--
-- DROP before CREATE is required, not stylistic: SECURITY DEFINER cannot be
-- removed by CREATE OR REPLACE alone in a way the migration corpus can prove,
-- and the guard reads the corpus.
--
-- Idempotent (US-1108): IF EXISTS on the drop, OR REPLACE on the create,
-- self-record footer.

DROP FUNCTION IF EXISTS public.ensure_sourcer(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.ensure_sourcer(p_owner uuid, p_member uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
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

COMMENT ON FUNCTION public.ensure_sourcer(uuid, uuid, text) IS
  'US-2886: add or link one roster entry. SECURITY INVOKER on purpose (00673) so a direct call is bound by the RLS on public.sourcers; the 00672 triggers call it from their own definer context.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00673')
ON CONFLICT (version) DO NOTHING;
