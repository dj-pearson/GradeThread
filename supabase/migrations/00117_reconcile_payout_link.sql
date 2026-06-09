-- Atomic payout↔sale reconciliation link (US-462).
--
-- /run and /match previously did TWO separate writes — payout_imports
-- (sale_id, reconciled) then sales (payout_reference) — and a failure of the
-- second left a payout marked reconciled with the sale side never linked (a
-- half-linked row that only got logged). This RPC does both writes in ONE
-- transaction (a plpgsql function body is atomic: it either commits both or
-- rolls back both). It is:
--   • tenant-scoped — verifies the payout (own user_id) AND the sale (via its
--     inventory_items.user_id) belong to p_user_id before touching anything
--     (US-268; sales carries no user_id of its own);
--   • idempotent — re-linking the SAME pair is a no-op success, so re-running
--     /run over an already-matched row is safe;
--   • self-repairing — when a payout is already reconciled to this sale but the
--     sale's payout_reference was never written (the old failure mode), it
--     backfills the sale side.
-- Rows are locked FOR UPDATE so two concurrent reconcilers can't double-link.

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

  RETURN jsonb_build_object('ok', true, 'already_linked', false, 'repaired', false);
END;
$$;

-- Service-role (the edge reconciler) only — never anon/authenticated.
REVOKE ALL ON FUNCTION public.reconcile_payout_link(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_payout_link(uuid, uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_payout_link(uuid, uuid, uuid, text) TO service_role;
