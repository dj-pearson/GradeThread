-- US-600: Consignment mode (web portal layer).
--
-- The base `consignors` table + the inventory_items.consignor_id /
-- consignment_split_pct link already exist (00107_consignors.sql, US-676 / iOS).
-- This migration adds the web consignor-PORTAL surface on top:
--   * consignor status + Stripe Connect payout fields + intake e-sign fields on
--     `consignors`;
--   * a `consignor_payouts` ledger (Stripe transfer ids + status);
--   * a `consignor_pnl` security-invoker view for per-consignor P&L.
--
-- We only ADD to `consignors` (never rename its existing columns) so the iOS
-- ConsignorService keeps working unchanged. Split economics use NET proceeds
-- (sale_price minus selling fees) to match 00107's "share of NET sale proceeds".

BEGIN;

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.consignor_status AS ENUM (
  'active', 'paused', 'archived'
);

CREATE TYPE public.consignor_payout_status AS ENUM (
  'pending', 'processing', 'paid', 'failed', 'canceled'
);

-- ══════════════════════════════════════════════════════════
-- CONSIGNORS: portal / payout fields
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.consignors
  ADD COLUMN IF NOT EXISTS status                   public.consignor_status NOT NULL DEFAULT 'active',
  -- Stripe Connect (Express) destination account for payouts.
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS payouts_enabled          boolean NOT NULL DEFAULT false,
  -- Intake e-sign: who signed the consignment agreement, when, which version.
  ADD COLUMN IF NOT EXISTS intake_signed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS intake_signature_name    text,
  ADD COLUMN IF NOT EXISTS intake_agreement_version text;

CREATE INDEX IF NOT EXISTS idx_consignors_status ON public.consignors(status);

-- ══════════════════════════════════════════════════════════
-- CONSIGNOR_PAYOUTS (ledger)
-- ══════════════════════════════════════════════════════════

CREATE TABLE public.consignor_payouts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  consignor_id      uuid NOT NULL REFERENCES public.consignors(id) ON DELETE CASCADE,
  -- Optional linkage to the originating sale / item for per-item reconciliation.
  sale_id           uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  amount            decimal(10,2) NOT NULL CHECK (amount >= 0),
  status            public.consignor_payout_status NOT NULL DEFAULT 'pending',
  stripe_transfer_id text,
  note              text,
  error             text,
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_consignor_payouts_user_id ON public.consignor_payouts(user_id);
CREATE INDEX idx_consignor_payouts_consignor_id ON public.consignor_payouts(consignor_id);
CREATE INDEX idx_consignor_payouts_status ON public.consignor_payouts(status);

CREATE TRIGGER set_consignor_payouts_updated_at
  BEFORE UPDATE ON public.consignor_payouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.consignor_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own consignor payouts"
  ON public.consignor_payouts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create consignor payouts"
  ON public.consignor_payouts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own consignor payouts"
  ON public.consignor_payouts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own consignor payouts"
  ON public.consignor_payouts FOR DELETE USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════
-- PER-CONSIGNOR P&L (security-invoker view — caller's RLS applies)
-- ══════════════════════════════════════════════════════════
--
-- One row per consignor. net_proceeds = sale_price minus selling fees
-- (platform + payment-processing). consignor_share applies the per-item split
-- snapshot (falling back to the consignor's default split) to net_proceeds.

CREATE VIEW public.consignor_pnl WITH (security_invoker = true) AS
WITH item_sales AS (
  SELECT
    i.consignor_id,
    i.id                                                        AS item_id,
    i.status                                                    AS item_status,
    COALESCE(i.consignment_split_pct, c.default_split_pct)      AS split_pct,
    s.sale_price                                                AS sale_price,
    (COALESCE(s.sale_price, 0)
       - COALESCE(s.platform_fees, 0)
       - COALESCE(s.payment_processing_fees, 0))                AS net_proceeds
  FROM public.inventory_items i
  JOIN public.consignors c ON c.id = i.consignor_id
  LEFT JOIN public.sales s ON s.inventory_item_id = i.id
  WHERE i.consignor_id IS NOT NULL
),
rollup AS (
  SELECT
    consignor_id,
    COUNT(DISTINCT item_id)                                                     AS total_items,
    COUNT(DISTINCT item_id) FILTER (
      WHERE item_status IN ('sold', 'shipped', 'completed')
    )                                                                          AS items_sold,
    COALESCE(SUM(sale_price), 0)                                               AS gross_revenue,
    COALESCE(SUM(net_proceeds), 0)                                             AS net_proceeds,
    COALESCE(SUM(net_proceeds * split_pct / 100.0), 0)                         AS consignor_share,
    COALESCE(SUM(net_proceeds * (100.0 - split_pct) / 100.0), 0)              AS store_share
  FROM item_sales
  GROUP BY consignor_id
)
SELECT
  c.id                                                       AS consignor_id,
  c.user_id,
  c.name,
  c.default_split_pct,
  c.status,
  c.payouts_enabled,
  COALESCE(r.total_items, 0)                                 AS total_items,
  COALESCE(r.items_sold, 0)                                  AS items_sold,
  COALESCE(r.gross_revenue, 0)                               AS gross_revenue,
  COALESCE(r.net_proceeds, 0)                                AS net_proceeds,
  COALESCE(r.consignor_share, 0)                             AS consignor_share,
  COALESCE(r.store_share, 0)                                 AS store_share,
  COALESCE(p.payouts_paid, 0)                                AS payouts_paid,
  COALESCE(p.payouts_pending, 0)                             AS payouts_pending,
  GREATEST(COALESCE(r.consignor_share, 0) - COALESCE(p.payouts_paid, 0), 0) AS balance_owed
FROM public.consignors c
LEFT JOIN rollup r ON r.consignor_id = c.id
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)                     AS payouts_paid,
    COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'processing')), 0) AS payouts_pending
  FROM public.consignor_payouts cp
  WHERE cp.consignor_id = c.id
) p ON TRUE;

GRANT SELECT ON public.consignor_pnl TO authenticated;
GRANT SELECT ON public.consignor_pnl TO service_role;

COMMIT;
