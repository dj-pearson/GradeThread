-- US-1827: portfolio value-peak / significant-move alerts.
--
-- The valuation cache (00428) gains the state an alert needs: the all-time peak
-- estimate (for "new high" alerts) and the last value we alerted on (so a
-- significant move is measured from the last notification, not re-fired every
-- run). The alerts cron reuses the US-1803 notification infra (frequency caps
-- honored by notifyBuyer) and is gated to Connoisseur buyers.

ALTER TABLE public.closet_item_valuations
  ADD COLUMN IF NOT EXISTS peak_estimate_cents        integer,
  ADD COLUMN IF NOT EXISTS last_alert_estimate_cents  integer,
  ADD COLUMN IF NOT EXISTS last_alerted_at            timestamptz,
  -- US-1827 best-time-to-sell guidance: 'sell_now' | 'hold' | 'watch' | 'unknown'.
  ADD COLUMN IF NOT EXISTS sell_guidance              text NOT NULL DEFAULT 'unknown';

INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'buyer.portfolio_alerts',
  jsonb_build_object(
    'move_threshold_pct', 15,
    'min_estimate_cents', 2000
  ),
  'json',
  jsonb_build_object(
    'move_threshold_pct', 15,
    'min_estimate_cents', 2000
  ),
  'buyer',
  'Buyer portfolio alert thresholds (US-1827). move_threshold_pct = % change from '
  'the last-alerted value that fires a significant-move alert; min_estimate_cents = '
  'items valued under this are too small to alert on. A new all-time peak fires a '
  'value-peak alert. Negative/invalid values are clamped.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00429')
ON CONFLICT (version) DO NOTHING;
