-- 00686_ledger_rebuild_no_revoke.sql
--
-- US-3002: remove the crash surface 00685 added, without opening the hole the
-- revoke was there to close.
--
-- ⚠ WHAT WAS WRONG. 00685 ended with
--     REVOKE ALL ON FUNCTION public.rebuild_ledger_for_user(uuid) FROM public;
-- and that migration is APPLIED IN PRODUCTION. On this Postgres image a DENIED
-- function call from anon or authenticated SEGFAULTS the backend and restarts
-- the whole database, because supautils appends a GRANT hint to the error
-- (US-2403). anon is the key that ships in the browser bundle, and PostgREST
-- exposes this function at /rpc/rebuild_ledger_for_user - confirmed present in
-- the production OpenAPI document - so the revoke put a database restart one
-- unauthenticated request away.
--
-- It also broke the feature it was protecting. rebuild_my_ledger() is SECURITY
-- INVOKER, so it needs EXECUTE as the CALLING role; with execute revoked from
-- public, every authenticated seller pressing rebuild took the denial path.
--
-- ⚠ DELIBERATELY NO REVOKE HERE, and that is not an oversight. Restoring the
-- default EXECUTE is the same posture every other function in this schema has.
-- The permission question is answered in the function BODY instead, which
-- raises an ordinary 42501 and arms neither problem - the shape 00612 uses and
-- vault/20-domain/postgres-revoke-from-anon-is-a-noop.md owns.
--
-- Idempotent: CREATE OR REPLACE, and a GRANT that is a no-op when already held.

CREATE OR REPLACE FUNCTION public.rebuild_ledger_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_written integer := 0;
BEGIN
  -- ── US-3002: the authorization check, in the BODY ────────────────────────
  --
  -- 00685 protected this function with `REVOKE ALL ... FROM public`, which is
  -- the one thing a migration on this stack must never do. See the header.
  --
  -- SECURITY DEFINER with a caller-supplied user id needs a check somewhere,
  -- and this is where it can live safely. Two callers are legitimate:
  --   * the service role, which is how the jobs and the edge rebuild a ledger;
  --   * a signed-in seller rebuilding THEIR OWN, which is the rebuild_my_ledger
  --     path - and note that path is SECURITY INVOKER, so under 00685's revoke
  --     it was denied for every authenticated user, i.e. the crash was on the
  --     ordinary user-facing route rather than on some admin corner.
  --
  -- Anything else raises an ordinary 42501, which is a normal error rather than
  -- a permission denial at the privilege layer, and so arms nothing.
  IF auth.role() IS NOT NULL
     AND auth.role() <> 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id)
  THEN
    RAISE EXCEPTION 'rebuild_ledger_for_user: may only rebuild your own ledger'
      USING ERRCODE = '42501';
  END IF;
  -- Accounts are looked up by code once, into a temp mapping, so a typo in a
  -- code is a hard failure here rather than a silently skipped entry.
  CREATE TEMP TABLE IF NOT EXISTS _acct (code text PRIMARY KEY, id uuid)
    ON COMMIT DROP;
  DELETE FROM _acct;
  INSERT INTO _acct (code, id)
    SELECT code, id FROM public.ledger_accounts WHERE user_id IS NULL;

  -- Everything derived for this user is replaced wholesale. Adjustments are
  -- NEVER touched: they are the correction mechanism (US-2995) and a rebuild
  -- that erased them would erase the only record of why a number moved.
  DELETE FROM public.ledger_entries
   WHERE user_id = p_user_id AND source_kind <> 'adjustment';

  -- 1..8: the sale.
  INSERT INTO public.ledger_entries
    (user_id, entry_date, account_id, amount_cents, currency, memo,
     source_kind, source_id, source_detail)
  SELECT p_user_id, e.d, a.id, e.cents, coalesce(e.cur, 'USD'), e.memo,
         e.kind, e.sid, e.detail
  FROM (
    SELECT s.sale_date::date AS d, s.currency AS cur, s.id AS sid,
           'sale'::text AS kind, 'price'::text AS detail,
           (s.sale_price * 100)::bigint AS cents,
           'sales_revenue'::text AS code,
           coalesce(i.title, 'Sale') AS memo
      FROM public.sales s
      LEFT JOIN public.inventory_items i ON i.id = s.inventory_item_id
     WHERE s.user_id = p_user_id AND s.status = 'completed'

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'sale', 'shipping',
           (s.shipping_collected * 100)::bigint, 'shipping_income',
           'Shipping the buyer paid'
      FROM public.sales s
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND s.shipping_collected <> 0

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'sale', 'tax',
           (s.tax * 100)::bigint, 'sales_tax_collected',
           'Sales tax the marketplace collected and paid'
      FROM public.sales s
     WHERE s.user_id = p_user_id AND s.status = 'completed' AND s.tax <> 0

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'fee', 'fees',
           -((s.platform_fees + s.payment_processing_fees) * 100)::bigint,
           'platform_fees', 'Selling and payment fees'
      FROM public.sales s
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND (s.platform_fees + s.payment_processing_fees) <> 0

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'shipping', 'label',
           -(s.shipping_cost * 100)::bigint, 'shipping_postage',
           'Shipping label'
      FROM public.sales s
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND s.shipping_cost <> 0

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'cogs', 'grading',
           -(s.grading_cost * 100)::bigint, 'cogs_other', 'Grading'
      FROM public.sales s
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND s.grading_cost <> 0

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'cogs', 'other',
           -(s.other_costs * 100)::bigint, 'cogs_other', 'Other cost of sale'
      FROM public.sales s
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND s.other_costs <> 0

    -- Cost of the item, dated at the SALE rather than the purchase. That is
    -- what a cash-method reseller treating inventory as non-incidental does,
    -- and it is what finances_dashboard has always computed. The purchase date
    -- is still on the item, so US-2986 can ask the other question.
    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'cogs', 'cogs',
           -(i.acquired_price * 100)::bigint, 'purchases',
           'Cost of ' || coalesce(i.title, 'item')
      FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND i.acquired_price IS NOT NULL AND i.acquired_price <> 0

    -- The legacy shipments table, and ONLY when the sale row carries no
    -- shipping of its own. Same guard finances_dashboard uses; without it the
    -- label is deducted twice.
    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'shipping', 'legacy_shipment',
           -(sh.ship_total * 100)::bigint, 'shipping_postage',
           'Shipping (from the shipments record)'
      FROM public.sales s
      JOIN (
        SELECT DISTINCT ON (sale_id) sale_id,
               (shipping_cost + label_cost) AS ship_total
          FROM public.shipments ORDER BY sale_id, created_at DESC
      ) sh ON sh.sale_id = s.id
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND coalesce(s.shipping_cost, 0) = 0 AND sh.ship_total <> 0
  ) e
  JOIN _acct a ON a.code = e.code;

  GET DIAGNOSTICS v_written = ROW_COUNT;

  -- 9: operating expenses. The account is the seller's explicit choice when
  -- they made one, else the default for the category.
  INSERT INTO public.ledger_entries
    (user_id, entry_date, account_id, amount_cents, memo,
     source_kind, source_id, source_detail)
  SELECT p_user_id, x.spent_on,
         coalesce(x.account_id, a.id),
         -(x.amount * 100)::bigint,
         coalesce(nullif(trim(x.description), ''), 'Operating expense'),
         'expense', x.id, 'expense'
    FROM public.flipdesk_expenses x
    LEFT JOIN _acct a
      ON a.code = public.default_account_for_category(x.category)
   WHERE x.user_id = p_user_id AND x.amount <> 0;

  -- 10: payouts. Cash movement, on an 'asset' account, deliberately outside
  -- net. The sale was already booked when it happened; counting the deposit as
  -- income would double it.
  INSERT INTO public.ledger_entries
    (user_id, entry_date, account_id, amount_cents, currency, memo,
     source_kind, source_id, source_detail)
  SELECT p_user_id, p.payout_date::date, a.id, p.amount_cents,
         coalesce(p.currency, 'USD'),
         'Payout ' || p.payout_id, 'payout', p.id, 'payout'
    FROM public.ebay_payouts p
    JOIN _acct a ON a.code = 'cash_payout'
   WHERE p.user_id = p_user_id
     AND p.amount_cents IS NOT NULL AND p.payout_date IS NOT NULL;

  RETURN (SELECT count(*)::integer FROM public.ledger_entries
           WHERE user_id = p_user_id);
END;
$$;

-- Restore the default the revoke removed. A denied call is the crash; the guard
-- above is what makes granting this safe.
GRANT EXECUTE ON FUNCTION public.rebuild_ledger_for_user(uuid) TO public;
GRANT EXECUTE ON FUNCTION public.rebuild_ledger_for_user(uuid) TO service_role;

insert into public.applied_migrations (version) values ('00686') on conflict do nothing;
