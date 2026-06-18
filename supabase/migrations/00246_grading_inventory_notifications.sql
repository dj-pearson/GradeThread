-- US-1056: grading-lifecycle & inventory notifications.
--
-- Adds three notification_type enum values:
--   • grading_failed     — a grade run threw / a required angle couldn't be
--                          analyzed (the charge was reversed).
--   • grading_incomplete — the pre-grade quality gate abstained (needs_photos):
--                          the photos couldn't be graded, so no grade was made.
--   • low_stock          — a listing's available quantity crossed down into
--                          low-stock / stockout territory.
--
-- ADD VALUE IF NOT EXISTS is idempotent and safe to run outside a using-
-- transaction (we never reference the new values later in this migration).
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'grading_failed';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'grading_incomplete';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'low_stock';

-- Configurable low-stock threshold (system_settings registry, 00207/00208).
-- A listing whose available quantity falls to this value (or fewer, but > 0)
-- emits a `low_stock` notification; 0 emits a stockout notice. Operators retune
-- it deploy-free via the admin settings editor. Key matches
-- LOW_STOCK_THRESHOLD_SETTING_KEY in lib/inventory-monitor.ts; value matches
-- DEFAULT_LOW_STOCK_THRESHOLD. `on conflict do nothing` so a manual override
-- applied before a re-run is never clobbered.
insert into public.system_settings (key, value, value_type, default_value, category, description)
values (
  'inventory_low_stock_threshold',
  to_jsonb(1),
  'number',
  to_jsonb(1),
  'inventory',
  'US-1056: available quantity at or below which a listing emits a low-stock notification (a quantity of 0 emits a stockout notice instead). Alerts fire only on a downward crossing into a worse level, so a steady-state sync never re-notifies. Higher = warn earlier; 0 = stockout alerts only.'
) on conflict (key) do nothing;
