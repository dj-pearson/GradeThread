-- US-1123: feed reconciled payout truth into consignor P&L.
--
-- Until now the consignor_pnl view (00171) computed every consignor's net
-- proceeds (and therefore their share) from the SALE-PRICE ESTIMATE
-- (sale_price − platform_fees − payment_processing_fees). Once a payout has been
-- reconciled (reconciliation matches a payout_imports row to the sale), we know
-- the REAL net the marketplace deposited — so consignors should be paid on that
-- number, not the estimate. This migration:
--
--   1. adds consignor_payouts.payout_reference — back-filled by reconciliation to
--      link each consignor ledger row to the real payout (audit trail);
--   2. teaches reconcile_payout_link (00117) to back-fill that reference whenever
--      a payout is matched to a sale of a consigned item (atomic with the link);
--   3. recreates consignor_pnl so net_proceeds / consignor_share use the
--      reconciled payout_imports.amount when a sale is matched, falling back to
--      the estimate only when unreconciled — and EXPOSES the estimate-vs-actual
--      discrepancy (estimated_* columns + *_delta) so over/under-payments are
--      visible and can be trued up.
--
-- Idempotent (US-1108): ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP VIEW IF EXISTS + CREATE VIEW (+ re-GRANT), self-record footer.

BEGIN;

-- ══════════════════════════════════════════════════════════
-- 1. consignor_payouts.payout_reference — the real-payout link.
-- ══════════════════════════════════════════════════════════
-- Stores the matched payout_imports.id (as text) so the ledger row points at the
-- reconciled marketplace payout it was (or should be) paid from. NULL until the
-- sale is reconciled.
ALTER TABLE public.consignor_payouts
  ADD COLUMN IF NOT EXISTS payout_reference text;

COMMENT ON COLUMN public.consignor_payouts.payout_reference IS
  'US-1123: id of the reconciled public.payout_imports row this payout is backed '
  'by, back-filled by reconcile_payout_link when the sale is matched. NULL while '
  'the sale is unreconciled (the share was computed from the sale-price estimate).';

-- ══════════════════════════════════════════════════════════
-- 2. reconcile_payout_link — back-fill the consignor ledger reference.
-- ══════════════════════════════════════════════════════════
-- Same atomic, tenant-scoped, idempotent, self-repairing link as 00117, plus a
-- back-fill of consignor_payouts.payout_reference for any payout row tied to the
-- matched sale (only for consigned items — non-consigned sales have no such row,
-- so the UPDATE is a harmless no-op). Tenant-scoped by user_id; only fills a NULL
-- reference (never re-points an already-linked ledger row).
CREATE OR REPLACE FUNCTION public.reconcile_payout_link(
  p_user_id          uuid,
  p_payout_import_id uuid,
  p_sale_id          uuid,
  p_payout_reference text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout_user       uuid;
  v_payout_sale       uuid;
  v_payout_reconciled boolean;
  v_sale_owner        uuid;
  v_sale_payout_ref   text;
  v_repaired          boolean := false;
BEGIN
  -- Lock + ownership-check the payout.
  SELECT user_id, sale_id, reconciled
    INTO v_payout_user, v_payout_sale, v_payout_reconciled
    FROM public.payout_imports
    WHERE id = p_payout_import_id
    FOR UPDATE;
  IF NOT FOUND OR v_payout_user IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payout_not_found');
  END IF;

  -- Lock + ownership-check the sale (tenant via inventory_items). Locks only
  -- the sales row, not the joined inventory_items.
  SELECT i.user_id, s.payout_reference
    INTO v_sale_owner, v_sale_payout_ref
    FROM public.sales s
    JOIN public.inventory_items i ON i.id = s.inventory_item_id
    WHERE s.id = p_sale_id
    FOR UPDATE OF s;
  IF NOT FOUND OR v_sale_owner IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sale_not_found');
  END IF;

  -- Already linked to THIS sale → idempotent no-op, but repair the sale side if
  -- the old non-atomic path left it unwritten.
  IF v_payout_reconciled AND v_payout_sale = p_sale_id THEN
    IF p_payout_reference IS NOT NULL AND v_sale_payout_ref IS NULL THEN
      UPDATE public.sales SET payout_reference = p_payout_reference WHERE id = p_sale_id;
      v_repaired := true;
    END IF;
    -- Back-fill the consignor ledger reference (no-op for non-consigned sales).
    UPDATE public.consignor_payouts
      SET payout_reference = p_payout_import_id::text
      WHERE sale_id = p_sale_id
        AND user_id = p_user_id
        AND payout_reference IS NULL;
    RETURN jsonb_build_object('ok', true, 'already_linked', true, 'repaired', v_repaired);
  END IF;

  -- Payout already reconciled to a DIFFERENT sale → conflict.
  IF v_payout_reconciled AND v_payout_sale IS NOT NULL AND v_payout_sale <> p_sale_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payout_already_reconciled');
  END IF;

  -- Sale already linked to a DIFFERENT payout reference → conflict.
  IF p_payout_reference IS NOT NULL
     AND v_sale_payout_ref IS NOT NULL
     AND v_sale_payout_ref <> p_payout_reference THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sale_linked_elsewhere');
  END IF;

  -- Atomic two-table write: both or neither.
  UPDATE public.payout_imports
    SET sale_id = p_sale_id, reconciled = true
    WHERE id = p_payout_import_id;

  IF p_payout_reference IS NOT NULL AND v_sale_payout_ref IS NULL THEN
    UPDATE public.sales
      SET payout_reference = p_payout_reference
      WHERE id = p_sale_id;
  END IF;

  -- Back-fill the consignor ledger reference (no-op for non-consigned sales).
  UPDATE public.consignor_payouts
    SET payout_reference = p_payout_import_id::text
    WHERE sale_id = p_sale_id
      AND user_id = p_user_id
      AND payout_reference IS NULL;

  RETURN jsonb_build_object('ok', true, 'already_linked', false, 'repaired', false);
END;
$$;

-- Service-role (the edge reconciler) only — never anon/authenticated.
REVOKE ALL ON FUNCTION public.reconcile_payout_link(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_payout_link(uuid, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_payout_link(uuid, uuid, uuid, text) TO service_role;

-- ══════════════════════════════════════════════════════════
-- 3. consignor_pnl — reconciled-aware net proceeds + share, with the
--    estimate-vs-actual delta surfaced.
-- ══════════════════════════════════════════════════════════
-- DROP + CREATE (rather than CREATE OR REPLACE) so we can freely add columns
-- without the same-leading-columns constraint. Re-GRANT after recreate.
DROP VIEW IF EXISTS public.consignor_pnl;

CREATE VIEW public.consignor_pnl WITH (security_invoker = true) AS
WITH item_sales AS (
  SELECT
    i.consignor_id,
    i.id                                                        AS item_id,
    i.status                                                    AS item_status,
    COALESCE(i.consignment_split_pct, c.default_split_pct)      AS split_pct,
    s.sale_price                                                AS sale_price,
    -- The sale-price estimate (sale_price − selling fees).
    (COALESCE(s.sale_price, 0)
       - COALESCE(s.platform_fees, 0)
       - COALESCE(s.payment_processing_fees, 0))                AS estimated_net,
    -- The reconciled marketplace payout, when one (or more) payout_imports rows
    -- have been matched to this sale. NULL ⇒ unreconciled ⇒ fall back to estimate.
    pr.reconciled_net                                           AS reconciled_net
  FROM public.inventory_items i
  JOIN public.consignors c ON c.id = i.consignor_id
  LEFT JOIN public.sales s ON s.inventory_item_id = i.id
  LEFT JOIN LATERAL (
    SELECT SUM(pi.amount) AS reconciled_net
    FROM public.payout_imports pi
    WHERE pi.sale_id = s.id AND pi.reconciled = true
    HAVING COUNT(*) > 0
  ) pr ON TRUE
  WHERE i.consignor_id IS NOT NULL
),
priced AS (
  SELECT
    consignor_id,
    item_id,
    item_status,
    split_pct,
    sale_price,
    estimated_net,
    reconciled_net,
    -- Effective net the consignor is paid on: real reconciled payout when known,
    -- else the estimate. This drives net_proceeds + consignor_share.
    COALESCE(reconciled_net, estimated_net)                     AS effective_net,
    (reconciled_net IS NOT NULL)                                AS is_reconciled
  FROM item_sales
),
rollup AS (
  SELECT
    consignor_id,
    COUNT(DISTINCT item_id)                                                     AS total_items,
    COUNT(DISTINCT item_id) FILTER (
      WHERE item_status IN ('sold', 'shipped', 'completed')
    )                                                                          AS items_sold,
    COUNT(DISTINCT item_id) FILTER (WHERE is_reconciled)                       AS items_reconciled,
    COUNT(DISTINCT item_id) FILTER (
      WHERE item_status IN ('sold', 'shipped', 'completed') AND NOT is_reconciled
    )                                                                          AS items_unreconciled,
    COALESCE(SUM(sale_price), 0)                                               AS gross_revenue,
    COALESCE(SUM(effective_net), 0)                                            AS net_proceeds,
    COALESCE(SUM(estimated_net), 0)                                            AS estimated_net_proceeds,
    COALESCE(SUM(reconciled_net), 0)                                           AS reconciled_net_proceeds,
    COALESCE(SUM(effective_net * split_pct / 100.0), 0)                        AS consignor_share,
    COALESCE(SUM(estimated_net * split_pct / 100.0), 0)                        AS estimated_consignor_share,
    COALESCE(SUM(effective_net * (100.0 - split_pct) / 100.0), 0)             AS store_share
  FROM priced
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
  GREATEST(COALESCE(r.consignor_share, 0) - COALESCE(p.payouts_paid, 0), 0) AS balance_owed,
  -- US-1123: reconciliation transparency. estimated_* mirror the pre-reconciled
  -- numbers; *_delta = actual − estimate (positive ⇒ the marketplace paid more
  -- than estimated, negative ⇒ less, so an estimate-based payout was over/under).
  COALESCE(r.items_reconciled, 0)                            AS items_reconciled,
  COALESCE(r.items_unreconciled, 0)                          AS items_unreconciled,
  COALESCE(r.estimated_net_proceeds, 0)                      AS estimated_net_proceeds,
  COALESCE(r.reconciled_net_proceeds, 0)                     AS reconciled_net_proceeds,
  COALESCE(r.estimated_consignor_share, 0)                   AS estimated_consignor_share,
  (COALESCE(r.net_proceeds, 0) - COALESCE(r.estimated_net_proceeds, 0))       AS net_proceeds_delta,
  (COALESCE(r.consignor_share, 0) - COALESCE(r.estimated_consignor_share, 0)) AS consignor_share_delta
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

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00304')
ON CONFLICT (version) DO NOTHING;
