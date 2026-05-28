-- Admin audit-log coverage via DB triggers (US-269).
--
-- Edge admin handlers already write admin_audit_log (see admin-billing.ts
-- auditLog()), but several admin actions happen as DIRECT client Supabase
-- calls from the admin UI (RLS-gated by is_admin()), with no edge choke point
-- to log them. The most security-sensitive of those are privilege/access
-- changes on users: role and suspended.
--
-- These triggers capture exactly that gap. They fire only for client-driven
-- (JWT) mutations — auth.uid() is the acting admin. Service-role edge writes
-- have a NULL auth.uid() and are logged by the handlers themselves, so we skip
-- them here to avoid NULL actors / double-logging.

CREATE OR REPLACE FUNCTION public.log_user_admin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  -- Only log attributable, client-driven changes. admin_audit_log.admin_user_id
  -- is NOT NULL, so a NULL actor (service-role) can't be recorded here anyway.
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, details)
    VALUES (
      v_actor, 'user.role_change', 'user', NEW.id,
      jsonb_build_object('before', OLD.role, 'after', NEW.role, 'source', 'db_trigger')
    );
  END IF;

  IF NEW.suspended IS DISTINCT FROM OLD.suspended THEN
    INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, target_id, details)
    VALUES (
      v_actor, 'user.suspended_change', 'user', NEW.id,
      jsonb_build_object('before', OLD.suspended, 'after', NEW.suspended, 'source', 'db_trigger')
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_user_admin_change ON public.users;
CREATE TRIGGER trg_log_user_admin_change
  AFTER UPDATE ON public.users
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.suspended IS DISTINCT FROM NEW.suspended)
  EXECUTE FUNCTION public.log_user_admin_change();

-- Note: admin_audit_log is already effectively append-only — migration 00003
-- defines only SELECT + INSERT RLS policies (no UPDATE/DELETE), so with RLS
-- enabled those operations are denied for non-service-role callers.
