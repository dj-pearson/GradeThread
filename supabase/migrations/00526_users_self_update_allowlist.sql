-- US-2283: make the users self-update guard DENY-BY-DEFAULT.
--
-- 00076/00331/00402 froze a hand-listed set of columns. public.users has ~100,
-- and every column added since had to be remembered into that list or it
-- silently became writable by the account owner through PostgREST. Six were
-- missed, including included_grades_this_period and ai_actions_used_this_month
-- — a logged-in customer could grant themselves unlimited grading billed to us.
--
-- The list is now inverted: SELF_SERVICE names what an end user MAY change and
-- everything else is refused, so a new column is closed the day it is added
-- rather than the day someone remembers it. The comparison is on
-- to_jsonb(NEW) - SELF_SERVICE vs to_jsonb(OLD) - SELF_SERVICE, which covers
-- every present and future column without naming any of them.
--
-- Unchanged: only auth.role() = 'authenticated' (browser/app) sessions are
-- guarded. Service-role edge writes, SECURITY DEFINER triggers and admin DB
-- sessions still manage these columns — that is where entitlement changes
-- belong. See vault/20-domain/service-role-tables.md for the split.
--
-- The allowlist was derived from the actual client write paths (src/, ios/),
-- not from judgement: every column below is written today by the browser SPA or
-- the iOS app on the user's own row. usage_alert_thresholds and the legal
-- acceptance columns are deliberately NOT here — those surfaces already write
-- through the edge, so allowing them would widen the guard for nothing.

CREATE OR REPLACE FUNCTION public.guard_users_protected_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- The ONLY columns an end user may change on their own row.
  self_service constant text[] := ARRAY[
    -- Stamped by set_users_updated_at; must never be the reason for a refusal.
    'updated_at',
    -- Profile (settings.tsx, ios ProfileStore/AuthStore).
    'full_name', 'avatar_url',
    -- Business & shipping profile (settings.tsx, US-325).
    'business_name', 'business_phone', 'ship_from_address',
    -- Preferences.
    'notification_preferences', 'share_sale_outcomes',
    'sync_conflict_email_threshold',
    'ai_enrichment_enabled', 'ai_action_limit',
    'promote_listings_by_default', 'default_promo_rate_pct', 'default_promo_mode',
    -- Onboarding + one-shot dismissals.
    'onboarded_at', 'use_case', 'flipdesk_onboarded',
    'dismissed_flipdesk_promo', 'dismissed_ebay_publish_disclaimer',
    -- Which workspace the user is currently looking at (US-1636).
    'active_workspace_owner_id'
  ];
  changed text[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Name the offending columns rather than raising a generic refusal: the
  -- previous message listed categories, so a legitimate client write that
  -- tripped it gave the developer nothing to act on.
  SELECT array_agg(o.key ORDER BY o.key)
    INTO changed
    FROM jsonb_each(to_jsonb(OLD) - self_service) AS o
    JOIN jsonb_each(to_jsonb(NEW) - self_service) AS n ON n.key = o.key
   WHERE n.value IS DISTINCT FROM o.value;

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION
      'users: column(s) % cannot be modified by the account owner (role, suspension, plan, billing, usage and entitlement columns are service-role only)',
      array_to_string(changed, ', ');
  END IF;

  RETURN NEW;
END;
$$;

-- Idempotent re-wire: CREATE OR REPLACE above leaves the existing trigger
-- pointing at the new body, but re-creating it keeps this file safe to apply on
-- a database where 00076 never ran.
DROP TRIGGER IF EXISTS guard_users_protected_columns ON public.users;
CREATE TRIGGER guard_users_protected_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_users_protected_columns();

COMMENT ON FUNCTION public.guard_users_protected_columns() IS
  'US-347 (00331) + US-1799 (00402) + US-2283 (00526): DENY-BY-DEFAULT guard on public.users self-updates. An authenticated (browser/app) session may change only the self-service columns enumerated in the function body; every other column, present or future, is refused. Service-role and SECURITY DEFINER paths bypass via the auth.role() check.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00526')
ON CONFLICT (version) DO NOTHING;
