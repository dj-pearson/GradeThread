-- US-1112: automatic consignor payout when a consigned item sells.
--
-- A recorded sale of a consigned item should automatically compute the
-- consignor's share (reusing the consignor_pnl split math) and create the
-- payout — rather than relying on an operator to fire each one manually via
-- POST /payouts. This migration adds the substrate the auto-payout engine
-- (lib/consignor-payout.ts + the consignor-payouts cron) needs:
--
--   * consignor_payouts.source — distinguishes operator-created ('manual',
--     the existing default) from engine-created ('auto') rows so the manual
--     override path and the automatic path never clobber each other;
--   * a partial UNIQUE index on (sale_id) for source='auto' so re-ingesting
--     the same sale can NEVER create a duplicate automatic payout (idempotent);
--   * consignor_auto_payout_mode — the config flag (off | batched | immediate)
--     that gates whether/when the engine fires.
--
-- Idempotent (US-1108): IF NOT EXISTS column + index, ON CONFLICT seed, footer.

BEGIN;

-- Provenance of a payout row: operator (manual override) vs engine (automatic).
ALTER TABLE public.consignor_payouts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'auto'));

COMMENT ON COLUMN public.consignor_payouts.source IS
  'US-1112: who created this payout — manual (operator via POST /payouts) or '
  'auto (the sale-ingest auto-payout engine). The (sale_id) uniqueness below '
  'applies only to auto rows so the engine is idempotent on re-ingest while the '
  'manual override can still record additional payouts for the same sale.';

-- Idempotency backstop: at most ONE automatic payout per sale. A concurrent
-- immediate-hook + cron race loses on the 23505 here and is treated as
-- "already created" by the engine.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_consignor_payouts_auto_sale
  ON public.consignor_payouts (sale_id)
  WHERE source = 'auto' AND sale_id IS NOT NULL;

-- Config flag (system_settings registry, 00207/00208). value_type is one of
-- number|bool|string|json (00208 check) — 'string' here.
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'consignor_auto_payout_mode',
    '"batched"'::jsonb, 'string', '"batched"'::jsonb,
    'US-1112: how the consignor auto-payout engine fires. off = disabled (manual POST /payouts only); batched = the consignor-payouts cron sweeps recently-sold consigned items; immediate = additionally fire at eBay sale ingest (the batched cron still runs as the catch-all). A transfer only sends for an onboarded (Stripe Connect) consignor; otherwise the payout is queued as pending until onboarding completes.',
    'flipdesk'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00301')
ON CONFLICT (version) DO NOTHING;
