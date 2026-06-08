-- US-737: expand the notification system to cover lifecycle events.
--
-- Adds the new in-app notification types and a single "selling_activity"
-- preference category that gates the FlipDesk lifecycle notifications
-- (listing live / sale recorded / payout imported / item status change).
-- Grading notifications keep reusing the existing "grade_complete" pref.

-- New notification_type enum values. ADD VALUE IF NOT EXISTS is idempotent and
-- safe to run outside a using-transaction (we never reference the new values
-- later in this migration).
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'grading_submitted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'grading_ready';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'item_status_change';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'listing_live';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'sale_recorded';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'payout_imported';

-- New default preference set for users created from here on.
ALTER TABLE public.users
  ALTER COLUMN notification_preferences SET DEFAULT '{
    "grade_complete": {"email": true, "in_app": true},
    "dispute_updates": {"email": true, "in_app": true},
    "billing_alerts": {"email": true},
    "product_updates": {"email": true},
    "selling_activity": {"email": true, "in_app": true}
  }'::jsonb;

-- Backfill existing rows so the new category is present and defaulted-on.
-- withPreferenceDefaults() already fills it on read, but persisting it keeps
-- the settings UI and the edge pref-check consistent for current users.
UPDATE public.users
  SET notification_preferences =
    notification_preferences
    || '{"selling_activity": {"email": true, "in_app": true}}'::jsonb
  WHERE NOT (notification_preferences ? 'selling_activity');
