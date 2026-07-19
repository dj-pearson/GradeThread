-- US-2022: consignor payout reversal + optional hold window.
--
-- A settled consignor payout had no reversal path: when the sale was later
-- returned or refunded the row stayed 'paid' forever, the money never came
-- back, and nothing signalled the loss. See lib/consignor-reversal-math.ts for
-- why reversal was chosen over a negative-balance offset.
--
-- NOTE ON ENUM VALUES: 'reversed' and 'clawback_pending' are added here but are
-- NOT used by any statement in this file. A new enum value cannot be USED in
-- the same transaction that adds it (Postgres), and the edge only writes them
-- after the boot guard confirms this version.

ALTER TYPE public.consignor_payout_status ADD VALUE IF NOT EXISTS 'reversed';
ALTER TYPE public.consignor_payout_status ADD VALUE IF NOT EXISTS 'clawback_pending';

ALTER TABLE public.consignor_payouts
  ADD COLUMN IF NOT EXISTS stripe_reversal_id text,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_error text,
  ADD COLUMN IF NOT EXISTS hold_until timestamptz;

COMMENT ON COLUMN public.consignor_payouts.stripe_reversal_id IS
  'Stripe transfer-reversal id when a paid payout was clawed back after the sale reversed (US-2022).';
COMMENT ON COLUMN public.consignor_payouts.reversal_error IS
  'Why an attempted reversal failed. Set together with status=clawback_pending: the money left the connected account and only a human can recover it.';
COMMENT ON COLUMN public.consignor_payouts.hold_until IS
  'Optional return-window hold (US-2022 AC3). The transfer will not fire before this stamp. NULL = no hold, which is the default; the hold is opt-in per seller via the consignor_payout_config setting.';

-- The reversal sweep looks up payouts by sale, and the ops surface lists rows
-- needing human recovery. Neither had an index.
CREATE INDEX IF NOT EXISTS idx_consignor_payouts_sale_id
  ON public.consignor_payouts(sale_id) WHERE sale_id IS NOT NULL;

insert into public.applied_migrations (version) values ('00481') on conflict do nothing;
