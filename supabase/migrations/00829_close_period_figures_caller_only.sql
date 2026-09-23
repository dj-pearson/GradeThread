-- 00829_close_period_figures_caller_only.sql
--
-- SECURITY: close_period's closing_figures covered EVERY seller, not the one
-- closing.
--
-- close_period is SECURITY DEFINER (it has to be: closed_periods has no
-- INSERT policy). It built closing_figures by calling ledger_reconciliation()
-- and cogs_worksheet(), which are SECURITY INVOKER and have no user filter of
-- their own; they rely on RLS. Inside a definer function they run as the
-- function owner, which bypasses RLS, so they summed ledger_entries,
-- inventory_items, inventory_snapshots and (through finances_dashboard) sales
-- for the whole database. Measured locally before this file: seller A with
-- one $57 sale closed 2025 and recorded ledger_sale_net_cents 45700,
-- sold_item_count 2 and $220 of purchases, all including seller B's rows.
-- Every period ever closed stored figures that mix other tenants' money into
-- the seller's own record, and the seller can read that record.
--
-- The fix computes the figures here, filtered to v_uid explicitly, instead of
-- calling the RLS-scoped functions:
--   * 'ledger' has the same keys as ledger_reconciliation(). The ledger half
--     is the same query with e.user_id = v_uid. dashboard_net_cents comes from
--     public.sale_pnl, whose net is finances_dashboard's net_profit term for
--     term (00801 header; scripts/check-sale-pnl-invariant.mjs holds them
--     equal to the cent), filtered to user_id = v_uid.
--   * 'cogs' is cogs_worksheet()'s body from 00690 with a user filter on each
--     of its six table reads, and nothing else changed.
-- ledger_reconciliation(), cogs_worksheet() and finances_dashboard() are NOT
-- changed: called by a client they run under RLS and are already scoped. No
-- other SECURITY DEFINER function calls either of them (grep of
-- supabase/migrations, 2026-09-23).
--
-- Carried forward from 00826, which is the current close_period: the
-- rebuild_ledger_for_user(v_uid) before the snapshot, the snapshot, the US-3002
-- body guard and NO REVOKE (US-2403). Same signature, replaced in place;
-- grants restated. Idempotent. Rules: vault/50-business/books-and-taxes.md.

CREATE OR REPLACE FUNCTION public.close_period(
  p_period_start date,
  p_period_end   date,
  p_label        text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_ledger jsonb;
  v_cogs jsonb;
  v_figures jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.closed_periods
     WHERE user_id = v_uid AND reopened_at IS NULL
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RAISE EXCEPTION 'That period is already closed.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 00826: the ledger as of NOW, not as of the last time something asked for
  -- a rebuild. Before the snapshot and the figures, while writes are allowed.
  PERFORM public.rebuild_ledger_for_user(v_uid);

  -- The inventory valuation FIRST, while writes are still allowed. Closing
  -- before snapshotting would lock the very table the snapshot reads from and
  -- leave the period closed with no Part III figures.
  PERFORM public.take_inventory_snapshot(
    v_uid, p_period_end, p_label, false);

  -- 00829: ledger_reconciliation(p_period_start), scoped to v_uid. This is a
  -- definer function, so RLS does not apply and every read names the seller.
  WITH dash AS (
    SELECT (round(coalesce(sum(p.net), 0)::numeric, 2) * 100)::bigint
             AS dashboard_net_cents
      FROM public.sale_pnl p
     WHERE p.user_id = v_uid
       AND p.sale_date >= p_period_start::timestamptz
  ),
  led AS (
    SELECT
      coalesce(sum(e.amount_cents) FILTER (
        WHERE a.flow <> 'excluded' AND a.flow <> 'asset'
          AND e.source_kind <> 'expense'), 0) AS sale_net_cents,
      coalesce(sum(e.amount_cents) FILTER (
        WHERE e.source_kind = 'expense'), 0) AS overhead_cents,
      coalesce(sum(e.amount_cents) FILTER (
        WHERE a.flow = 'excluded'), 0) AS excluded_cents,
      count(*) AS entry_count
      FROM public.ledger_entries e
      JOIN public.ledger_accounts a ON a.id = e.account_id
     WHERE e.user_id = v_uid
       AND e.entry_date >= p_period_start
  )
  SELECT jsonb_build_object(
    'dashboard_net_cents', dash.dashboard_net_cents,
    'ledger_sale_net_cents', led.sale_net_cents,
    'variance_cents', led.sale_net_cents - dash.dashboard_net_cents,
    'agrees', led.sale_net_cents = dash.dashboard_net_cents,
    'overhead_cents', led.overhead_cents,
    'true_net_cents', led.sale_net_cents + led.overhead_cents,
    'excluded_cents', led.excluded_cents,
    'entry_count', led.entry_count
  ) INTO v_ledger FROM dash, led;

  -- 00829: cogs_worksheet(p_period_start, p_period_end) from 00690, with a
  -- user filter on each table read and nothing else changed.
    WITH beginning AS (
      SELECT total_cost_cents, item_count, items_without_cost, reconstructed
        FROM public.inventory_snapshots
       WHERE user_id = v_uid AND as_of = p_period_start
       LIMIT 1
    ),
    ending AS (
      SELECT total_cost_cents, item_count, items_without_cost, reconstructed
        FROM public.inventory_snapshots
       WHERE user_id = v_uid AND as_of = p_period_end
       LIMIT 1
    ),
    purchases AS (
      SELECT coalesce(sum((i.acquired_price * 100)::bigint), 0) AS cents,
             count(*)::integer AS cnt,
             count(*) FILTER (WHERE i.acquired_price IS NULL)::integer AS nulls
        FROM public.inventory_items i
       WHERE i.user_id = v_uid
         AND i.acquired_date IS NOT NULL
         AND i.acquired_date::date >= p_period_start
         AND i.acquired_date::date <  p_period_end
    ),
    -- What the ledger says the sold items cost. Negative there (a cost), flipped
    -- here so the two figures are comparable without the reader doing sign
    -- arithmetic in their head.
    -- US-3007. Schedule C Part III line 36 is "Purchases less cost of items
    -- withdrawn for personal use", so a personal-use withdrawal reduces PURCHASES
    -- and does so in the period it was WITHDRAWN, which need not be the period it
    -- was acquired.
    personal_use AS (
      SELECT coalesce(sum((i.acquired_price * 100)::bigint), 0) AS cents,
             count(*)::integer AS cnt
        FROM public.inventory_items i
       WHERE i.user_id = v_uid
         AND i.removed_reason = 'personal_use'
         AND i.removed_on >= p_period_start
         AND i.removed_on <  p_period_end
    ),
    -- The other four reasons reduce ENDING INVENTORY and flow through line 42.
    -- Reported rather than booked: nothing here writes a ledger entry, because a
    -- write-off is not automatically a deduction (US-3007 AC3).
    writeoffs AS (
      SELECT coalesce(sum((i.acquired_price * 100)::bigint), 0) AS cents,
             count(*)::integer AS cnt
        FROM public.inventory_items i
       WHERE i.user_id = v_uid
         AND i.removed_reason IS NOT NULL
         AND i.removed_reason <> 'personal_use'
         AND i.removed_on >= p_period_start
         AND i.removed_on <  p_period_end
    ),
    sold AS (
      SELECT coalesce(-sum(e.amount_cents), 0) AS cents,
             count(*)::integer AS cnt
        FROM public.ledger_entries e
        JOIN public.ledger_accounts a ON a.id = e.account_id
       WHERE e.user_id = v_uid
         AND a.code = 'purchases'
         AND e.entry_date >= p_period_start
         AND e.entry_date <  p_period_end
    )
    SELECT jsonb_build_object(
      'from', p_period_start,
      'to', p_period_end,
      'line_35_beginning_cents', coalesce((SELECT total_cost_cents FROM beginning), 0),
      'line_35_present',         (SELECT count(*) FROM beginning) > 0,
      'line_35_reconstructed',   coalesce((SELECT reconstructed FROM beginning), false),
      'line_36_purchases_cents',
        (SELECT cents FROM purchases) - (SELECT cents FROM personal_use),
      'line_36_gross_purchases_cents', (SELECT cents FROM purchases),
      'line_36_personal_use_cents',    (SELECT cents FROM personal_use),
      'line_36_personal_use_count',    (SELECT cnt FROM personal_use),
      'line_41_ending_cents',    coalesce((SELECT total_cost_cents FROM ending), 0),
      'line_41_present',         (SELECT count(*) FROM ending) > 0,
      'line_41_reconstructed',   coalesce((SELECT reconstructed FROM ending), false),
      'line_42_cogs_cents',
        coalesce((SELECT total_cost_cents FROM beginning), 0)
        + (SELECT cents FROM purchases) - (SELECT cents FROM personal_use)
        - coalesce((SELECT total_cost_cents FROM ending), 0),
      'sold_cost_basis_cents',   (SELECT cents FROM sold),
      'sold_item_count',         (SELECT cnt FROM sold),
      'variance_cents',
        (coalesce((SELECT total_cost_cents FROM beginning), 0)
         + (SELECT cents FROM purchases) - (SELECT cents FROM personal_use)
         - coalesce((SELECT total_cost_cents FROM ending), 0))
        - (SELECT cents FROM sold),
      'items_without_cost', jsonb_build_object(
        'beginning', coalesce((SELECT items_without_cost FROM beginning), 0),
        'purchases', (SELECT nulls FROM purchases),
        'ending',    coalesce((SELECT items_without_cost FROM ending), 0)
      ),
      'purchase_item_count', (SELECT cnt FROM purchases),
      -- US-3007: what left without selling, so a non-zero variance reads as
      -- "these items left inventory" rather than as books that do not balance.
      'writeoffs_cents',      (SELECT cents FROM writeoffs),
      'writeoff_item_count',  (SELECT cnt FROM writeoffs),
      -- The residual once write-offs are accounted for. THIS is the figure that
      -- should be zero; variance_cents alone will not be once anything has been
      -- written off, and that is correct rather than a fault.
      'variance_after_writeoffs_cents',
        (coalesce((SELECT total_cost_cents FROM beginning), 0)
         + (SELECT cents FROM purchases) - (SELECT cents FROM personal_use)
         - coalesce((SELECT total_cost_cents FROM ending), 0))
        - (SELECT cents FROM sold)
        - (SELECT cents FROM writeoffs)
    )
  INTO v_cogs;

  -- AC1: the figures as they stood, so a later recomputation can be COMPARED
  -- against what was filed rather than silently replacing it.
  SELECT jsonb_build_object(
    'ledger', v_ledger,
    'cogs', v_cogs,
    'snapshot_total_cents', (
      SELECT total_cost_cents FROM public.inventory_snapshots
       WHERE user_id = v_uid AND as_of = p_period_end
    ),
    'closed_on', now()
  ) INTO v_figures;

  INSERT INTO public.closed_periods
    (user_id, period_start, period_end, label, closing_figures, closed_by)
  VALUES (v_uid, p_period_start, p_period_end, p_label, v_figures, v_uid)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

grant execute on function public.close_period(date, date, text) to authenticated;
grant execute on function public.close_period(date, date, text) to service_role;

insert into public.applied_migrations (version) values ('00829') on conflict do nothing;
