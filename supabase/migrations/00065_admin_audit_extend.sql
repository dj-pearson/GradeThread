-- Admin audit-log coverage, round 2 (US-269).
--
-- Builds on 00046 (which logs users.role / users.suspended changes). This:
--   1. Enriches admin_audit_log with actor_role / ip / user_agent and allows a
--      NULL actor so SYSTEM actions (e.g. the content scheduler tick) can be
--      recorded with actor_role='system'.
--   2. Adds DB triggers for two more client-driven admin mutations named in the
--      AC — dispute status changes and ai_prompt_versions activation — mirroring
--      the 00046 pattern (fire only for JWT/auth.uid() callers; service-role
--      edge writes are logged by the handlers via writeAuditLog()).

-- 1. Schema enrichment ------------------------------------------------------

ALTER TABLE public.admin_audit_log
  ADD COLUMN IF NOT EXISTS actor_role  text,
  ADD COLUMN IF NOT EXISTS ip          text,
  ADD COLUMN IF NOT EXISTS user_agent  text;

-- Allow a NULL actor for system-originated entries (scheduler tick). The
-- admin_user_id FK stays; NULL is permitted and means "not a human admin"
-- (actor_role then carries 'system'). Human entries remain attributable.
ALTER TABLE public.admin_audit_log
  ALTER COLUMN admin_user_id DROP NOT NULL;

-- 2. Dispute status-change trigger -----------------------------------------

CREATE OR REPLACE FUNCTION public.log_dispute_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    -- Service-role edge write (e.g. an admin resolve endpoint) logs itself.
    RETURN NEW;
  END IF;

  INSERT INTO public.admin_audit_log
    (admin_user_id, actor_role, action, target_type, target_id, details)
  VALUES (
    v_actor,
    (SELECT role::text FROM public.users WHERE id = v_actor),
    'dispute.status_change',
    'dispute',
    NEW.id,
    jsonb_build_object(
      'before', OLD.status,
      'after', NEW.status,
      'resolution_notes', NEW.resolution_notes,
      'source', 'db_trigger'
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_dispute_status_change ON public.disputes;
CREATE TRIGGER trg_log_dispute_status_change
  AFTER UPDATE ON public.disputes
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.log_dispute_status_change();

-- 3. AI prompt activation trigger ------------------------------------------

CREATE OR REPLACE FUNCTION public.log_ai_prompt_active_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.admin_audit_log
    (admin_user_id, actor_role, action, target_type, target_id, details)
  VALUES (
    v_actor,
    (SELECT role::text FROM public.users WHERE id = v_actor),
    'ai_prompt.active_change',
    'ai_prompt_version',
    NEW.id,
    jsonb_build_object(
      'before', OLD.is_active,
      'after', NEW.is_active,
      'version_name', NEW.version_name,
      'source', 'db_trigger'
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_ai_prompt_active_change ON public.ai_prompt_versions;
CREATE TRIGGER trg_log_ai_prompt_active_change
  AFTER UPDATE ON public.ai_prompt_versions
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
  EXECUTE FUNCTION public.log_ai_prompt_active_change();

-- admin_audit_log remains append-only: 00003 defines only SELECT + INSERT RLS
-- policies, so UPDATE/DELETE are denied for non-service-role callers.
