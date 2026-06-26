-- US-1295: Affiliate payout automation (Stripe Connect).
--
-- Clicks (00174 affiliate_clicks) and conversions (referral_events, tagged
-- attribution_source='affiliate') are already logged; rewarding affiliates was
-- manual until now. This migration adds the substrate to turn a converted
-- affiliate referral into real money paid out over the SAME Stripe Connect rails
-- the consignment engine uses (lib/consignor-payout.ts + the consignor-payouts
-- cron):
--
--   * affiliate_accounts  — one Stripe Connect Express account per affiliate
--     user (mirrors consignors.stripe_connect_account_id / payouts_enabled, but
--     keyed by the affiliate's own user_id since an affiliate IS a user);
--   * affiliate_commissions — the accrual ledger: one row per converted
--     affiliate referral (UNIQUE referral_event_id ⇒ accrual is idempotent),
--     held for a configurable window before it becomes payable, then claimed
--     into a payout;
--   * affiliate_payouts   — the payout ledger (Stripe transfer ids + status),
--     the idempotency unit for a batch transfer (idempotencyKey
--     `affiliate_payout_<id>`, same shape as consignor_payout_<id>);
--   * affiliate_payout_config — the system_settings registry key holding the
--     configurable rate / minimum-payout threshold / hold window / mode /
--     1099 tax threshold.
--
-- SECURITY (US-268): the edge service uses the service-role client which BYPASSES
-- RLS, so the engine scopes every write by affiliate_user_id. The RLS policies
-- below cover any direct client read (a user sees only their own rows).
--
-- Idempotent (US-1108): IF NOT EXISTS tables/columns/indexes, ON CONFLICT seed,
-- self-record footer.

BEGIN;

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- One Stripe Connect Express account per affiliate user. Created + onboarded via
-- POST /api/affiliate/connect; payouts_enabled mirrors Stripe's onboarding gate.
CREATE TABLE IF NOT EXISTS public.affiliate_accounts (
  user_id                   uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  stripe_connect_account_id text,
  payouts_enabled           boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- The accrual ledger: one row per converted affiliate referral. amount is the
-- configured commission ("rate") captured at accrual time. A row is `accrued`
-- (earning, possibly still inside its hold window), `paid` (claimed into a
-- payout), or `void` (reversed). hold_until gates when an accrued row becomes
-- payable. UNIQUE(referral_event_id) makes accrual idempotent — re-running the
-- accrual hook for the same conversion can never double-credit.
CREATE TABLE IF NOT EXISTS public.affiliate_commissions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  referral_event_id  uuid NOT NULL REFERENCES public.referral_events(id) ON DELETE CASCADE,
  amount             numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  status             text NOT NULL DEFAULT 'accrued'
                       CHECK (status IN ('accrued', 'paid', 'void')),
  hold_until         timestamptz NOT NULL DEFAULT now(),
  payout_id          uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_affiliate_commission_event UNIQUE (referral_event_id)
);

-- The payout ledger: one row per Stripe transfer batch. The payout id is the
-- idempotency unit — the engine fires the transfer with idempotencyKey
-- `affiliate_payout_<id>` so a retry on the SAME row can never double-pay.
CREATE TABLE IF NOT EXISTS public.affiliate_payouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount             numeric(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'canceled')),
  source             text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  stripe_transfer_id text,
  error              text,
  paid_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A commission is claimed into a payout via affiliate_commissions.payout_id.
-- (Declared as a separate FK so the table-creation order above is irrelevant on
-- a fresh apply.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_commissions_payout_id_fkey'
  ) THEN
    ALTER TABLE public.affiliate_commissions
      ADD CONSTRAINT affiliate_commissions_payout_id_fkey
      FOREIGN KEY (payout_id) REFERENCES public.affiliate_payouts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

-- The hot path: find an affiliate's accrued, past-hold, unclaimed commissions.
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_eligible
  ON public.affiliate_commissions (affiliate_user_id, hold_until)
  WHERE status = 'accrued' AND payout_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_payout
  ON public.affiliate_commissions (payout_id)
  WHERE payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_user
  ON public.affiliate_payouts (affiliate_user_id);
-- Sweep: retry payouts that haven't settled yet.
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_open
  ON public.affiliate_payouts (status)
  WHERE status IN ('pending', 'failed');

-- ══════════════════════════════════════════════════════════
-- updated_at TRIGGERS
-- ══════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS set_affiliate_accounts_updated_at ON public.affiliate_accounts;
CREATE TRIGGER set_affiliate_accounts_updated_at
  BEFORE UPDATE ON public.affiliate_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_affiliate_commissions_updated_at ON public.affiliate_commissions;
CREATE TRIGGER set_affiliate_commissions_updated_at
  BEFORE UPDATE ON public.affiliate_commissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_affiliate_payouts_updated_at ON public.affiliate_payouts;
CREATE TRIGGER set_affiliate_payouts_updated_at
  BEFORE UPDATE ON public.affiliate_payouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (a user reads only their own affiliate rows)
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.affiliate_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own affiliate account" ON public.affiliate_accounts;
CREATE POLICY "Users read own affiliate account"
  ON public.affiliate_accounts FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own affiliate commissions" ON public.affiliate_commissions;
CREATE POLICY "Users read own affiliate commissions"
  ON public.affiliate_commissions FOR SELECT USING (auth.uid() = affiliate_user_id);

DROP POLICY IF EXISTS "Users read own affiliate payouts" ON public.affiliate_payouts;
CREATE POLICY "Users read own affiliate payouts"
  ON public.affiliate_payouts FOR SELECT USING (auth.uid() = affiliate_user_id);

-- ══════════════════════════════════════════════════════════
-- CONFIG (system_settings registry, 00207/00208)
-- ══════════════════════════════════════════════════════════

-- value_type 'json' (00208 check allows number|bool|string|json). Ships DISABLED
-- (mode 'off') — an admin enables it after onboarding the Connect flow. rate =
-- flat USD commission per converted affiliate referral; minimum_payout = the
-- balance a payout must reach before it fires; hold_days = how long a commission
-- is held before it's payable (refund/clawback window); tax_threshold_usd = the
-- 1099-reporting flag threshold ($600 IRS default).
INSERT INTO public.system_settings (key, value, value_type, default_value, description, category)
VALUES
  (
    'affiliate_payout_config',
    '{"mode":"off","commission_per_conversion":5,"minimum_payout":25,"hold_days":30,"tax_threshold_usd":600}'::jsonb,
    'json',
    '{"mode":"off","commission_per_conversion":5,"minimum_payout":25,"hold_days":30,"tax_threshold_usd":600}'::jsonb,
    'US-1295: affiliate commission/payout economics. mode: off (no accrual/payout) | batched (the affiliate-payouts cron accrues conversions and pays eligible balances over Stripe Connect). commission_per_conversion = flat USD earned per converted affiliate referral. minimum_payout = USD balance required before a transfer fires. hold_days = days a commission is held before it becomes payable. tax_threshold_usd = 1099 reporting flag threshold.',
    'growth'
  )
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00310')
ON CONFLICT (version) DO NOTHING;
