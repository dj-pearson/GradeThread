-- Soft upgrade triggers — user-configurable thresholds + per-cap dedup (US-209).
--
-- US-209 wants a non-blocking "you've hit 80% of <cap>" toast that fires at
-- most once per cap per month, and a Settings chooser so power users can opt
-- into 50% / 80% / 95% alerts instead of the default 80%.
--
--   • usage_alert_thresholds — the percentages (out of 100) at which the user
--     wants to be warned. Default [80]. The Settings chooser offers 50/80/95.
--   • last_warning_at — dedup ledger so a given (cap, threshold) only toasts
--     once per calendar month, even across devices. Keyed "<cap>:<threshold>"
--     → "YYYY-MM" of the last firing. The frontend also mirrors this to
--     localStorage for instant client-side dedup; this column is the
--     cross-device source of truth. Despite the name (kept to match the US-209
--     AC), it stores a month-stamp map, not a single timestamp.
--
-- Both are written by the user themselves: thresholds via the edge endpoint
-- POST /api/payments/usage-alerts, the dedup map via POST /usage-alerts/fired.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS usage_alert_thresholds jsonb NOT NULL DEFAULT '[80]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_warning_at        jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.users.usage_alert_thresholds IS
  'US-209: percentages (out of 100) at which to surface a soft upgrade toast. Default [80]; Settings offers 50/80/95.';
COMMENT ON COLUMN public.users.last_warning_at IS
  'US-209: dedup ledger "<cap>:<threshold>" -> "YYYY-MM" so each soft trigger fires at most once per month per user. Not a timestamp.';
