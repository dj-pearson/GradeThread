-- US-915: Email deliverability hardening — SES warmup ramp settings.
--
-- Seeds the tunable warmup-ramp config into the system_settings registry so a
-- large marketing list is paced up over days (not sent in a burst) on a freshly
-- warmed SES identity. The per-tick batch bound (marketing_send_batch_limit,
-- seeded 00276) still caps burst within a day; these add the per-DAY ceilings.
--
-- Idempotent: ON CONFLICT DO NOTHING so an operator override applied before a
-- re-run is never clobbered. value_type is one of number|bool|string|json
-- (00208 check constraint) — note 'bool', not 'boolean'.

BEGIN;

INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'marketing_warmup_enabled',
    'false'::jsonb, 'bool', 'false'::jsonb,
    'US-915: when true, the SES warmup ramp caps daily marketing volume per marketing_warmup_schedule starting at marketing_warmup_start_date. Off by default so behaviour is unchanged until an operator opts in.',
    'marketing'
  ),
  (
    'marketing_warmup_schedule',
    '[50, 100, 500, 1000, 5000, 10000, 20000, 40000, 75000, 100000, 150000, 200000]'::jsonb,
    'json',
    '[50, 100, 500, 1000, 5000, 10000, 20000, 40000, 75000, 100000, 150000, 200000]'::jsonb,
    'US-915: per-day marketing send ceilings during the SES warmup ramp (index = days since marketing_warmup_start_date). Past the last entry the identity is warmed (no cap).',
    'marketing'
  ),
  (
    'marketing_warmup_start_date',
    '""'::jsonb, 'string', '""'::jsonb,
    'US-915: ISO date (YYYY-MM-DD) the SES warmup ramp began. Empty = ramp not started (no daily cap applied even when enabled).',
    'marketing'
  ),
  (
    'marketing_max_send_rate_per_sec',
    '14'::jsonb, 'number', '14'::jsonb,
    'US-915: SES account max send rate (messages/sec). Bounds the theoretical daily warmup ceiling (rate x 86400) so a cap can never exceed what SES will accept.',
    'marketing'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00292')
ON CONFLICT (version) DO NOTHING;
