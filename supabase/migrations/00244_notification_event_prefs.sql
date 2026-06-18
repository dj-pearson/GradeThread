-- US-1058: per-event notification preferences.
--
-- Adds granular notification types (buyer offers, returns) and splits the
-- coarse "selling_activity" preference into dedicated offers / returns / payouts
-- opt-out categories, each gated end-to-end by notify.ts (PREF_KEY). Also moves
-- the default preference set onto the per-event model with a push channel.

-- New notification_type enum values. ADD VALUE IF NOT EXISTS is idempotent and
-- safe to run outside a using-transaction (we never reference the new values
-- later in this migration).
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'offer_received';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'return_requested';

-- New default preference set for users created from here on. Mirrors
-- DEFAULT_NOTIFICATION_PREFERENCES in src/lib/notification-preferences.ts.
ALTER TABLE public.users
  ALTER COLUMN notification_preferences SET DEFAULT '{
    "grade_complete": {"email": true, "in_app": true, "push": true},
    "dispute_updates": {"email": true, "in_app": true},
    "billing_alerts": {"email": true, "in_app": true},
    "product_updates": {"email": true},
    "selling_activity": {"email": true, "in_app": true, "push": true},
    "offers": {"email": true, "in_app": true, "push": true},
    "returns": {"email": true, "in_app": true, "push": true},
    "payouts": {"email": true, "in_app": true, "push": true}
  }'::jsonb;

-- Backfill the new categories on existing rows, defaulted-on, without clobbering
-- any existing per-category choices. withPreferenceDefaults() already fills
-- missing channels (e.g. push) on read; persisting the new top-level categories
-- keeps the settings UI and the edge pref-check consistent for current users.
UPDATE public.users
  SET notification_preferences =
    notification_preferences
    || jsonb_build_object('offers', '{"email": true, "in_app": true, "push": true}'::jsonb)
  WHERE NOT (notification_preferences ? 'offers');

UPDATE public.users
  SET notification_preferences =
    notification_preferences
    || jsonb_build_object('returns', '{"email": true, "in_app": true, "push": true}'::jsonb)
  WHERE NOT (notification_preferences ? 'returns');

UPDATE public.users
  SET notification_preferences =
    notification_preferences
    || jsonb_build_object('payouts', '{"email": true, "in_app": true, "push": true}'::jsonb)
  WHERE NOT (notification_preferences ? 'payouts');
