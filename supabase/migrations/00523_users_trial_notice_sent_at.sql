-- US-2319: make the trial-ending notice idempotent AND recoverable.
--
-- The job's only dedupe was the exact-day window (daysLeft === 3), which the
-- code's own comment already called a seam: a missed cron day means the customer
-- gets NO warning before their trial ends, and a same-day manual re-run
-- double-sends. A stored marker removes both — the window can then widen to
-- "due or overdue, not yet sent" without ever repeating.
--
-- Added to guard_users_protected_columns because that guard is a DENYLIST: a new
-- column is writable by the account owner unless it is named. A trialist setting
-- this themselves would only suppress their own warning, but "only self-harm" is
-- how the entitlement holes in US-2283 were justified too.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS trial_notice_sent_at timestamptz;

COMMENT ON COLUMN public.users.trial_notice_sent_at IS
  'US-2319: when the trial-ending advance notice was sent. NULL = not sent. Written by the trial-expiry cron only; the exact-day window is no longer the dedupe.';

-- No index: the notice scan is already filtered to subscription_status
-- 'trialing' with a trial_ends_at window, which is a handful of rows. An index
-- here would cost more on every user write than it saves once a day.

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
     -- US-1799: buyer subscription billing columns (edge/webhook-only writers).
     OR NEW.buyer_plan IS DISTINCT FROM OLD.buyer_plan
     OR NEW.buyer_interval IS DISTINCT FROM OLD.buyer_interval
     OR NEW.buyer_subscription_status IS DISTINCT FROM OLD.buyer_subscription_status
     OR NEW.buyer_subscription_id IS DISTINCT FROM OLD.buyer_subscription_id
     OR NEW.buyer_period_end IS DISTINCT FROM OLD.buyer_period_end
     OR NEW.buyer_cancel_at_period_end IS DISTINCT FROM OLD.buyer_cancel_at_period_end
     -- US-2319: the trial-notice marker. Cron-written; clearing it would let a
     -- trialist re-trigger the notice, setting it would suppress their warning.
     OR NEW.trial_notice_sent_at IS DISTINCT FROM OLD.trial_notice_sent_at
  THEN
    RAISE EXCEPTION
      'users: protected account columns (role/suspension/plan/billing/usage) cannot be modified by the account owner';
  END IF;

  RETURN NEW;
END;
$$;

insert into public.applied_migrations (version) values ('00523') on conflict do nothing;
