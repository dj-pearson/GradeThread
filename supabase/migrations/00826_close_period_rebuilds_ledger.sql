-- close_period: rebuild the seller's ledger before freezing its figures.
--
-- 00702's close_period stores closing_figures from ledger_reconciliation(),
-- which reads ledger_entries. Those rows are written by
-- rebuild_ledger_for_user(), on demand, and never by a trigger on sales,
-- expenses or payouts. Nothing on the close path called it: not the RPC, not
-- src/lib/period-close.ts, not the period-close card. So a seller could close a
-- year and freeze figures missing every sale recorded since the ledger was
-- last built.
--
-- The fix is one PERFORM, before the snapshot and the figures. Everything else
-- is carried forward from 00702 unchanged, including the US-3002 shape: the
-- authorization check lives in the body and raises 42501, and there is NO
-- REVOKE, because a denied EXECUTE restarts this Postgres image (US-2403).
-- rebuild_ledger_for_user has its own body guard (00777) and passes here: the
-- caller's JWT claims are unchanged inside a SECURITY DEFINER call, so
-- auth.uid() is still v_uid.
--
-- Not changed here: a rebuild rewrites the seller's whole ledger, including
-- entries dated inside an earlier closed period. Keeping a rebuild away from
-- closed periods is a separate fix.
--
-- Same signature, so CREATE OR REPLACE replaces in place and the 00702 grants
-- stand; they are restated so the file reads whole. Idempotent.

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

  -- AC1: the figures as they stood, so a later recomputation can be COMPARED
  -- against what was filed rather than silently replacing it.
  SELECT jsonb_build_object(
    'ledger', public.ledger_reconciliation(p_period_start::timestamptz),
    'cogs', public.cogs_worksheet(p_period_start, p_period_end),
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

insert into public.applied_migrations (version) values ('00826') on conflict do nothing;
