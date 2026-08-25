-- US-2852 + US-2853: let the account owner write the eight preference columns
-- that 00668 and 00669 added.
--
-- 00526 made public.users self-updates DENY-BY-DEFAULT: an authenticated session
-- may change only the columns the guard function enumerates, and every column
-- added since — present or future — is refused. That is the correct posture and
-- it is exactly why this file has to exist. 00668 and 00669 added seven listing
-- defaults and one quiet-hours blob, all of them settings-screen controls, and
-- all of them frozen the moment they were created. The two settings cards would
-- have saved cleanly in every test and raised on the first real user.
--
-- Applied migrations are immutable and the guard is a CREATE OR REPLACE
-- function, so extending the allowlist means restating the whole body: 00567's
-- version, plus the eight new names and nothing else. Removals stay removed —
-- business_phone and ship_from_address are still absent on purpose (they are
-- edge-encrypted; see 00567).
--
-- ── WHY THESE EIGHT ARE SELF-SERVICE ────────────────────────────────────────
--
-- They are the same class of thing as the three promoted-listings columns
-- already on the list (00432): the owner's own preferences, with no billing,
-- entitlement or trust consequence. Nothing reads them to decide what to charge
-- or what to allow. The listing defaults only seed a draft the owner is about to
-- edit by hand anyway, and quiet hours only mutes the owner's own push.
--
-- The value guards live in CHECK constraints on the columns themselves (00668,
-- 00669), so a hostile write cannot store an ad rate of 400% or hour 99 — being
-- on this list buys the ability to set a legal value, not an arbitrary one.
--
-- No DDL. Idempotent by CREATE OR REPLACE.

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
    -- Seller listing defaults (US-2852, 00668). They seed a NEW composer draft
    -- and nothing else; a saved listing keeps its own values. CHECK constraints
    -- on the columns bound the legal values.
    'default_listing_format', 'default_auction_duration',
    'default_best_offer_enabled', 'default_best_offer_on_auction',
    'default_best_offer_accept_pct', 'default_best_offer_decline_pct',
    'default_listing_quantity',
    -- Quiet hours (US-2853, 00669). Mutes the owner's own push only; the in-app
    -- row and any email still send.
    'notification_quiet_hours',
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
  'US-347 (00331) + US-1799 (00402) + US-2283 (00526) + US-1861 (00550) + US-2417 (00567) + US-2852/US-2853 (00671): DENY-BY-DEFAULT guard on public.users self-updates. An authenticated (browser/app) session may change only the self-service columns enumerated in the function body; every other column, present or future, is refused. 00671 added the seven seller listing defaults and notification_quiet_hours. business_phone and ship_from_address stay removed — they are edge-encrypted and only the service role may write them. Service-role and SECURITY DEFINER paths bypass via the auth.role() check.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00671') ON CONFLICT DO NOTHING;
