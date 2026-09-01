-- 00710 — the Fit & Measurement Index opt-out (US-3038)
--
-- Contribution is OPT-OUT, which only holds if the switch actually works and
-- the disclosure is true. This file is the switch; the disclosure ships in the
-- same commit (privacy policy, Terms section 4, the retention row, /changelog).
--
-- ⚠ THE ALLOWLIST IS RESTATED BELOW, AND THAT IS THE POINT OF THIS FILE.
--
-- 00526 made public.users self-updates DENY-BY-DEFAULT: an authenticated
-- session may change only the columns named in `self_service`, and everything
-- else — present or future — is refused. So a new preference column added
-- without touching that function renders in settings, saves with no error, and
-- changes nothing. A privacy switch that silently does not work is worse than
-- no switch, because the user believes they have opted out.
--
-- ⚠ NO REVOKE ANYWHERE (US-2403). Copied forward from 00609/00708/00709: on
-- this Postgres image supautils decorates a permission-denied error with a
-- GRANT hint, and building that hint SEGFAULTS the backend on a FUNCTION
-- denial. Nothing here is revoked and nothing can build a hint.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS share_garment_measurements boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.users.share_garment_measurements IS
  'US-3038: whether this account''s garment measurements feed the aggregate behind the public Fit & Measurement Index. DEFAULT TRUE (opt-out), disclosed in the privacy policy and Terms section 4. Turning it OFF deletes the account''s existing garment_measurements rows via the trigger below; the next aggregate run then drops them from the published numbers.';

-- ── The allowlist, restated ────────────────────────────────────────────────
--
-- Copied from **00671**, which is the most recent definition, plus the one new
-- name. Restated in full rather than patched, because the function body IS the
-- list — there is no way to append to it from outside.
--
-- ⚠ COPY FROM THE LATEST DEFINITION, NOT FROM 00526. This file was first
-- written by copying 00526's list, which is the one the guard's own story is
-- named after and therefore the one you find first. It is six migrations out of
-- date. Doing that silently DROPPED eight columns that 00550/00668/00669/00671
-- had added — quiet hours, the Radar consent and the seven listing defaults
-- would all have started failing to save — and, worse, silently RE-ADDED
-- `business_phone` and `ship_from_address`, which 00671 removed on purpose
-- under US-2417 because a browser write would store plaintext over
-- AES-256-GCM ciphertext.
--
-- `src/test/users-self-update-allowlist.test.ts` caught it, but only the two
-- columns whose client write paths it can see. The listing defaults and the
-- security regression would have shipped. The migrations that have touched this
-- function, newest last: 00331, 00402, 00526, 00550, 00567, 00668, 00671.
-- `grep -l guard_users_protected_columns supabase/migrations/*.sql | tail -1`
-- is the file to copy from.

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
    -- Fit & Measurement Index contribution (US-3038, this migration).
    -- Self-service for the same reason radar_contribute is: a consent the
    -- person cannot withdraw from their own settings screen is not a
    -- consent. This one is OPT-OUT, which makes that more important, not
    -- less. The web settings card writes it directly; the edge only READS
    -- it, in isContributingMeasurements().
    'share_garment_measurements',
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

DROP TRIGGER IF EXISTS guard_users_protected_columns ON public.users;
CREATE TRIGGER guard_users_protected_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_users_protected_columns();

COMMENT ON FUNCTION public.guard_users_protected_columns() IS
  'US-347 (00331) + US-1799 (00402) + US-2283 (00526) + US-3038 (00710): DENY-BY-DEFAULT guard on public.users self-updates. An authenticated (browser/app) session may change only the self-service columns enumerated in the function body; every other column, present or future, is refused. Service-role and SECURITY DEFINER paths bypass via the auth.role() check.';

-- ── Opting out deletes what was already contributed ────────────────────────
--
-- In the DATABASE rather than in the client, because "stop contributing" and
-- "remove what I already contributed" are one promise to the user and must not
-- be two calls that can half-fail. Every write path — SPA, iOS, Android, an
-- admin session, a future one nobody has written — gets the same behaviour for
-- free, and none of them can forget it.
--
-- The published numbers are not rewritten here. The next aggregate run
-- recomputes the affected cohorts and drops any that fall under the floor,
-- which is what the retention copy says: already-published pages are
-- recomputed rather than frozen.

CREATE OR REPLACE FUNCTION public.purge_garment_measurements_on_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.share_garment_measurements IS DISTINCT FROM NEW.share_garment_measurements
     AND NEW.share_garment_measurements = false THEN
    DELETE FROM public.garment_measurements WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS purge_garment_measurements_on_optout ON public.users;
CREATE TRIGGER purge_garment_measurements_on_optout
  AFTER UPDATE OF share_garment_measurements ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.purge_garment_measurements_on_optout();

COMMENT ON FUNCTION public.purge_garment_measurements_on_optout() IS
  'US-3038: turning share_garment_measurements off deletes the account''s garment_measurements rows. In the database so that "stop contributing" and "remove what I contributed" are one promise rather than two calls that can half-fail, and so every client past and future gets it without remembering to.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00710') on conflict do nothing;
