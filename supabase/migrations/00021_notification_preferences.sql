-- Per-user notification preferences. Stored as JSONB on the users table so
-- a single row read carries the full preference set. Each notification type
-- maps to the channels it supports; default is every channel enabled.

ALTER TABLE public.users
  ADD COLUMN notification_preferences jsonb NOT NULL DEFAULT '{
    "grade_complete": {"email": true, "in_app": true},
    "dispute_updates": {"email": true, "in_app": true},
    "billing_alerts": {"email": true},
    "product_updates": {"email": true}
  }'::jsonb;
