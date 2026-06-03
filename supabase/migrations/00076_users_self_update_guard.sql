-- US-347: stop privilege escalation via the users self-update policy.
--
-- The original "Users can update own profile" policy (00001) had a USING clause
-- but NO WITH CHECK and NO column restriction. With RLS, an UPDATE policy
-- without WITH CHECK lets the row's NEW values pass unchecked — so an
-- authenticated user could PATCH their own users row from the browser and set
-- role='super_admin', clear suspended/flagged, zero grades_used_this_month, or
-- flip their plan / billing columns. The edge service (service-role) and the
-- handle_new_user trigger legitimately manage those columns; ordinary end users
-- must not touch them.
--
-- Defense in depth:
--   (1) WITH CHECK on the policy pins the row identity (can't repoint id).
--   (2) A BEFORE UPDATE trigger freezes the protected columns for updates made
--       by the `authenticated` role (the browser). Service-role (edge), the
--       SECURITY DEFINER handle_new_user trigger, and admin tooling run as other
--       roles and are unaffected, so billing/role/usage flows keep working.

-- ── (1) Policy: add the missing WITH CHECK ──────────────────────────
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;

CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── (2) Protected-column trigger ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_users_protected_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only end-user (browser) updates are guarded. Service-role (edge functions),
  -- SECURITY DEFINER triggers, and direct DB/admin sessions run under a
  -- different role and are permitted to manage these columns.
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.suspended IS DISTINCT FROM OLD.suspended
     OR NEW.flagged IS DISTINCT FROM OLD.flagged
     OR NEW.flag_reason IS DISTINCT FROM OLD.flag_reason
     OR NEW.moderation_status IS DISTINCT FROM OLD.moderation_status
     OR NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.grades_used_this_month IS DISTINCT FROM OLD.grades_used_this_month
     OR NEW.grade_reset_at IS DISTINCT FROM OLD.grade_reset_at
     OR NEW.grade_credit_balance IS DISTINCT FROM OLD.grade_credit_balance
     OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
     OR NEW.flipdesk_plan IS DISTINCT FROM OLD.flipdesk_plan
     OR NEW.flipdesk_interval IS DISTINCT FROM OLD.flipdesk_interval
     OR NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
     OR NEW.flipdesk_subscription_id IS DISTINCT FROM OLD.flipdesk_subscription_id
     OR NEW.flipdesk_period_end IS DISTINCT FROM OLD.flipdesk_period_end
     OR NEW.flipdesk_pause_until IS DISTINCT FROM OLD.flipdesk_pause_until
     OR NEW.flipdesk_cancel_at_period_end IS DISTINCT FROM OLD.flipdesk_cancel_at_period_end
     OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
     OR NEW.pending_flipdesk_plan IS DISTINCT FROM OLD.pending_flipdesk_plan
     OR NEW.pending_flipdesk_interval IS DISTINCT FROM OLD.pending_flipdesk_interval
  THEN
    RAISE EXCEPTION
      'users: protected account columns (role/suspension/plan/billing/usage) cannot be modified by the account owner';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_users_protected_columns ON public.users;
CREATE TRIGGER guard_users_protected_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_users_protected_columns();

COMMENT ON FUNCTION public.guard_users_protected_columns() IS
  'US-347: freezes role/suspension/moderation/plan/billing/usage columns against end-user (authenticated-role) self-updates. Service-role and SECURITY DEFINER paths bypass via the auth.role() check.';
