-- US-2417 AC1: close the browser's write path to the two columns that are now
-- AES-256-GCM ciphertext.
--
-- There is NO DDL here and that is the whole point. `business_phone` is already
-- text and `ship_from_address` is already jsonb; a jsonb column holds a JSON
-- string scalar, so the envelope fits in the existing column and no table is
-- rewritten under a lock. What has to change is PERMISSION: as long as an
-- authenticated session may write these two columns directly, a stale client, a
-- retried request or anyone with the anon key can put plaintext back, and the
-- encryption becomes a thing that is true of most rows.
--
-- 00526 made public.users self-updates DENY-BY-DEFAULT, enumerating the columns
-- an account owner may change. Applied migrations are immutable and the guard is
-- a CREATE OR REPLACE function, so the way to narrow it is to restate the whole
-- body here — 00550's version, with `business_phone` and `ship_from_address`
-- removed and nothing else touched.
--
-- `business_name` STAYS self-service. It is not encrypted, iOS writes it, and
-- removing it would break a client for no security gain. The web now sends all
-- three fields through PUT /api/account/shipping-profile because one Save button
-- should be one request, but that is a UI decision, not a permission one.

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
    -- Business profile (settings.tsx, US-325). business_phone and
    -- ship_from_address are NO LONGER HERE (US-2417): they are AES-256-GCM
    -- ciphertext bound to the owner, the key is edge-only, and the only writer
    -- is PUT /api/account/shipping-profile running as the service role. A
    -- direct browser write would store plaintext over a ciphertext, so it is
    -- refused with a message naming the column rather than silently accepted.
    'business_name',
    -- Preferences.
    'notification_preferences', 'share_sale_outcomes',
    'sync_conflict_email_threshold',
    'ai_enrichment_enabled', 'ai_action_limit',
    'promote_listings_by_default', 'default_promo_rate_pct', 'default_promo_mode',
    -- Thrift Radar contribution consent (US-1861). Self-service on purpose: a
    -- consent the person cannot withdraw from their own settings screen is not
    -- a consent. Both clients write it directly (web settings card, iOS
    -- RadarConsent); the edge only ever READS it.
    'radar_contribute',
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

COMMENT ON FUNCTION public.guard_users_protected_columns() IS
  'US-347 (00331) + US-1799 (00402) + US-2283 (00526) + US-1861 (00550) + US-2417 (00567): DENY-BY-DEFAULT guard on public.users self-updates. An authenticated (browser/app) session may change only the self-service columns enumerated in the function body; every other column, present or future, is refused. business_phone and ship_from_address were removed in 00567 — they are edge-encrypted and only the service role may write them. Service-role and SECURITY DEFINER paths bypass via the auth.role() check.';

COMMENT ON COLUMN public.users.ship_from_address IS
  'US-2417: AES-256-GCM ciphertext, AAD = this row''s id, stored as a jsonb STRING scalar. A jsonb OBJECT here is a row the backfill has not reached yet (services/edge-functions/scripts/backfill-user-shipping-pii.ts) and is tolerated on read. Never write this column from a client.';
COMMENT ON COLUMN public.users.business_phone IS
  'US-2417: AES-256-GCM ciphertext (v1:/v2: envelope), AAD = this row''s id. A value without that prefix is not yet backfilled and is tolerated on read. Never write this column from a client.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00567') on conflict do nothing;
