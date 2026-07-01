-- Fix: guard_users_protected_columns() (00076) references columns that do NOT
-- exist on public.users — `flagged`, `flag_reason`, `moderation_status`. Those
-- three are SUBMISSIONS moderation columns (added to public.submissions by
-- 00023_content_moderation.sql); they were never added to public.users. Because
-- PL/pgSQL only resolves record field references at RUNTIME, the BEFORE UPDATE
-- trigger throws `42703: record "new" has no field "flagged"` on EVERY
-- authenticated-role (browser) UPDATE of a users row.
--
-- Impact: all client-side users writes 400 — onboarding never persists
-- `onboarded_at` (so the onboarding modal loops forever), Settings profile /
-- notification / business saves fail, workspace switching, share-outcomes and
-- disclaimer dismissals, etc. Edge writes were unaffected because the
-- service-role short-circuit (auth.role() <> 'authenticated') returns before the
-- broken predicate is evaluated.
--
-- Fix: recreate the guard WITHOUT the three non-existent columns. User-level
-- moderation is already covered by the retained `suspended` guard; the removed
-- columns have no user-level meaning and are read nowhere in the app for users.

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

COMMENT ON FUNCTION public.guard_users_protected_columns() IS
  'US-347 (fixed 00331): freezes role/suspension/plan/billing/usage columns against end-user (authenticated-role) self-updates. Service-role and SECURITY DEFINER paths bypass via the auth.role() check. The 00076 version referenced submissions-only moderation columns (flagged/flag_reason/moderation_status) that do not exist on users, breaking all browser-side user updates with 42703.';

-- Self-record so the edge boot guard stays in sync (US-1108).
INSERT INTO public.applied_migrations (version) VALUES ('00331') ON CONFLICT DO NOTHING;
