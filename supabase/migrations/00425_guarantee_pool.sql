-- US-1822: insured purchase-guarantee claims-pool accounting, caps & circuit-breaker.
--
-- The guarantee is only credible if it's financially bounded and observable. A
-- single append-only ledger tracks the pool: ACCRUALS (a slice of buyer
-- subscription revenue, added per period) and DRAWDOWNS (one per paid remedy,
-- US-1821). Exposure = accrued − drawn; loss ratio = drawn / accrued. Per-period
-- and per-account caps + a loss-ratio circuit-breaker gate the auto-payout path
-- BEFORE any credit is granted (enforced in fileBuyerGuaranteeClaim). Admin-read
-- only (financial/operator data); all writes are service-role.

CREATE TABLE IF NOT EXISTS public.guarantee_pool_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type    text NOT NULL CHECK (entry_type IN ('accrual', 'drawdown')),
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  -- Accounting period, 'YYYY-MM' (UTC) — caps + loss ratio are per-period.
  period        text NOT NULL,
  -- The buyer on a drawdown (per-account cap); null on an accrual.
  account_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Idempotency handle: the claim id on a drawdown, a source key
  -- ('accrual:<period>') on an accrual. UNIQUE(entry_type, reference_id) makes a
  -- re-run a no-op — no double accrual, no double drawdown.
  reference_id  text NOT NULL DEFAULT '',
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_guarantee_pool_ledger_period
  ON public.guarantee_pool_ledger (period, entry_type);
CREATE INDEX IF NOT EXISTS idx_guarantee_pool_ledger_account
  ON public.guarantee_pool_ledger (account_user_id, period)
  WHERE entry_type = 'drawdown';

ALTER TABLE public.guarantee_pool_ledger ENABLE ROW LEVEL SECURITY;

-- Admin-read only; no buyer/owner read (this is pool-level financial data). All
-- writes are service-role (no INSERT/UPDATE policy).
DROP POLICY IF EXISTS "Admins read guarantee pool ledger" ON public.guarantee_pool_ledger;
CREATE POLICY "Admins read guarantee pool ledger"
  ON public.guarantee_pool_ledger FOR SELECT USING (public.is_admin());

-- ── admin-tunable pool economics + circuit-breaker ──────────────────────────
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'buyer.guarantee_pool',
  jsonb_build_object(
    'period_budget_cents', 500000,
    'per_account_period_cap_cents', 20000,
    'loss_ratio_throttle', 0.85,
    'accrual_per_active_sub_cents', 100
  ),
  'json',
  jsonb_build_object(
    'period_budget_cents', 500000,
    'per_account_period_cap_cents', 20000,
    'loss_ratio_throttle', 0.85,
    'accrual_per_active_sub_cents', 100
  ),
  'buyer',
  'Buyer guarantee claims-pool economics (US-1822), read at auto-payout time. '
  'period_budget_cents = max drawdown per period (0 = unlimited); '
  'per_account_period_cap_cents = max remedy one buyer can draw per period (0 = '
  'unlimited); loss_ratio_throttle = auto-payout throttles when drawn/accrued '
  'exceeds this (circuit-breaker; only applies once the period has accrual); '
  'accrual_per_active_sub_cents = accrued per active buyer subscription per period. '
  'A breached gate routes the claim to manual review instead of auto-paying.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00425')
ON CONFLICT (version) DO NOTHING;
