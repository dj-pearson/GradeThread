-- 00777_ledger_rebuild_safeupdate.sql
--
-- US-3298: the Money tab has read $0.00 in production since 00685, because
-- rebuild_ledger_for_user has never once run there.
--
-- ⚠ WHAT WAS WRONG, and it is one line:
--
--     DELETE FROM _acct;
--
-- Production loads the `safeupdate` extension. It refuses any UPDATE or DELETE
-- with no WHERE clause and raises SQLSTATE 21000, 'DELETE requires a WHERE
-- clause'. PostgREST maps 21000 to HTTP 400, which is the
-- `POST /rest/v1/rpc/rebuild_my_ledger -> 400` in the browser console.
--
-- The failure is TOTAL, not partial. `_acct` is cleared before anything is
-- written, so the function aborts on its first statement and no ledger row has
-- ever been inserted for any seller. Measured on production 2026-09-09 for the
-- owner's own account: 220 sales, 8 expenses, 33 global accounts, and
-- ledger_entries = 0. Every figure the Money tab derives from the ledger --
-- the overview cards, the whole Schedule C statement, the reconciliation --
-- therefore reads zero, and reads it CONFIDENTLY, with no error on screen.
-- `ensureLedgerBuilt()` rebuilds only when the ledger is empty, so the empty
-- ledger is exactly the state that triggers the call that cannot succeed.
--
-- WHY IT SURVIVED FOUR REWRITES OF THIS FUNCTION. The line was written in
-- 00685 and carried forward verbatim by 00686, 00691, 00695 and 00697, each of
-- which reproduces the whole body because CREATE OR REPLACE takes a whole body.
-- Nothing local catches it: `safeupdate` is not installed on the local stack
-- (checked 2026-09-09, pg_available_extensions has no row for it on
-- PostgreSQL 17.6), so `npm run check:ledger` builds a ledger happily here and
-- has done all along. This is the same shape as US-1552's `.or()` on a
-- mutation -- prod's Postgres is stricter than the one CI runs, in a way that
-- only a write can reveal.
--
-- ⚠ THE FIX IS TRUNCATE, NOT `WHERE true`. safeupdate inspects the planned
-- statement, and the planner constant-folds a true qual away before it gets
-- there, so `DELETE FROM _acct WHERE true` may or may not survive depending on
-- the version -- a coin flip is not a fix for a bug that hid for four months.
-- TRUNCATE is a utility statement, not CMD_DELETE, so safeupdate never sees it
-- at all. On a temp table it is also cheaper than the DELETE it replaces.
--
-- Nothing else in the body changes. The US-3002 authorization check, the
-- US-2987 facilitator-tax branches, the US-2989 mileage join and the US-2990
-- home-office block are carried forward from 00697 byte for byte, and the
-- second DELETE (`ledger_entries WHERE user_id = ... AND source_kind <>
-- 'adjustment'`) already has a WHERE clause and is untouched.
--
-- NO REVOKE. The grants from 00686 are re-issued after the CREATE OR REPLACE.
-- On this image a denied EXECUTE from anon or authenticated restarts the
-- database (US-2403); authorization stays in the body.
--
-- Risk: LOW. One function, replaced in place, same signature. It writes
-- nothing on its own -- a ledger is only rebuilt when something calls it.
-- Idempotent and re-run safe.

CREATE OR REPLACE FUNCTION public.rebuild_ledger_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_written integer := 0;
BEGIN
  -- US-3002: the authorization check, in the BODY. A REVOKE here would make a
  -- denied call restart the database on this Postgres image.
  IF auth.role() IS NOT NULL
     AND auth.role() <> 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id)
  THEN
    RAISE EXCEPTION 'rebuild_ledger_for_user: may only rebuild your own ledger'
      USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _acct (code text PRIMARY KEY, id uuid)
    ON COMMIT DROP;
  -- US-3298: TRUNCATE, not DELETE. Production loads `safeupdate`, which
  -- rejects a WHERE-less DELETE with SQLSTATE 21000 and aborted this
  -- function on its first statement for four months. See the header.
  TRUNCATE TABLE _acct;
  INSERT INTO _acct (code, id)
    SELECT code, id FROM public.ledger_accounts WHERE user_id IS NULL;

  DELETE FROM public.ledger_entries
   WHERE user_id = p_user_id AND source_kind <> 'adjustment';

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

    -- TAX, BRANCH 1: the marketplace collected and remitted it. Never the
    -- seller's income, so it lands on the excluded account and reaches no line
    -- -- but it IS inside the 1099-K gross, which is why it is recorded at all.
    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'sale', 'tax',
           (s.tax * 100)::bigint, 'sales_tax_collected',
           'Sales tax the marketplace collected and paid'
      FROM public.sales s
      LEFT JOIN public.listings l ON l.id = s.listing_id
     WHERE s.user_id = p_user_id AND s.status = 'completed' AND s.tax <> 0
       AND public.is_facilitator_collected(l.platform, s.sale_date::date)

    -- TAX, BRANCH 2: the SELLER collected it, so they are the retailer. The tax
    -- is part of gross receipts (line 1) and the remittance is a deduction
    -- (line 23). Two entries that net to zero, which is the right answer in
    -- aggregate and the right answer on each line -- one figure alone would put
    -- the tax on the wrong side of the return.
    --
    -- It assumes the tax was actually paid over. For a cash-method seller who
    -- collected in December and remits in January that is a timing difference,
    -- and it is smaller than the alternative of showing neither figure.
    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'sale', 'tax',
           (s.tax * 100)::bigint, 'sales_revenue',
           'Sales tax you collected'
      FROM public.sales s
      LEFT JOIN public.listings l ON l.id = s.listing_id
     WHERE s.user_id = p_user_id AND s.status = 'completed' AND s.tax <> 0
       AND NOT public.is_facilitator_collected(l.platform, s.sale_date::date)

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'sale', 'tax_remitted',
           -(s.tax * 100)::bigint, 'sales_tax_remitted',
           'Sales tax you paid over'
      FROM public.sales s
      LEFT JOIN public.listings l ON l.id = s.listing_id
     WHERE s.user_id = p_user_id AND s.status = 'completed' AND s.tax <> 0
       AND NOT public.is_facilitator_collected(l.platform, s.sale_date::date)

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

    UNION ALL
    SELECT s.sale_date::date, s.currency, s.id, 'cogs', 'cogs',
           -(i.acquired_price * 100)::bigint, 'purchases',
           'Cost of ' || coalesce(i.title, 'item')
      FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
     WHERE s.user_id = p_user_id AND s.status = 'completed'
       AND i.acquired_price IS NOT NULL AND i.acquired_price <> 0

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

  -- US-2989: mileage. Valued at the rate IN FORCE ON THE TRIP DATE, looked up
  -- rather than snapshotted, so last year's trips cannot reprice when a new
  -- rate lands -- and so a corrected rate flows through instead of being frozen
  -- into a row nobody thinks to revisit.
  --
  -- A trip with no rate for its date produces NO ENTRY. That is deliberate: a
  -- rate we do not have is not a rate of zero, and silently deducting nothing
  -- is worse than visibly deducting nothing, which the screen reports.
  INSERT INTO public.ledger_entries
    (user_id, entry_date, account_id, amount_cents, memo,
     source_kind, source_id, source_detail)
  SELECT p_user_id, t.trip_date, a.id,
         -round(t.miles * r.tenths_of_cent_per_mile / 10)::bigint,
         coalesce(nullif(trim(t.purpose), ''), 'Business driving')
           || ' (' || t.miles || ' miles)',
         'expense', t.id, 'mileage'
    FROM public.mileage_trips t
    JOIN _acct a ON a.code = 'vehicle_mileage'
    JOIN LATERAL (
      SELECT tenths_of_cent_per_mile FROM public.mileage_rates
       WHERE effective_from <= t.trip_date
         AND (effective_to IS NULL OR effective_to > t.trip_date)
       ORDER BY effective_from DESC LIMIT 1
    ) r ON true
   WHERE t.user_id = p_user_id AND t.miles > 0;

  -- US-2990: the home office, under the simplified method.
  --
  -- Dated at the LAST DAY OF THE TAX YEAR, not spread across it. The deduction
  -- is an annual computation -- square feet times a rate times months used --
  -- and there is no month it was "incurred" in. Dating it at year end keeps it
  -- inside the year it belongs to for every period selector without inventing
  -- twelve entries that each mean nothing on their own.
  --
  -- The rate and the cap come from the dated table, so a year is valued at the
  -- rate in force for it and last year cannot reprice.
  INSERT INTO public.ledger_entries
    (user_id, entry_date, account_id, amount_cents, memo,
     source_kind, source_id, source_detail)
  SELECT p_user_id,
         make_date(h.tax_year, 12, 31),
         a.id,
         -public.home_office_deduction_cents(
            h.square_feet, h.months_used, h.tax_year),
         'Home office, ' || h.square_feet || ' sq ft'
           || CASE WHEN h.months_used < 12
                   THEN ' for ' || h.months_used || ' months' ELSE '' END,
         'expense', h.id, 'home_office'
    FROM public.home_office_years h
    JOIN _acct a ON a.code = 'home_office'
   WHERE h.user_id = p_user_id
     AND h.method = 'simplified'
     AND h.square_feet > 0
     AND public.home_office_deduction_cents(
            h.square_feet, h.months_used, h.tax_year) > 0;

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

GRANT EXECUTE ON FUNCTION public.rebuild_ledger_for_user(uuid) TO public;
GRANT EXECUTE ON FUNCTION public.rebuild_ledger_for_user(uuid) TO service_role;

comment on function public.rebuild_ledger_for_user(uuid) is
  'US-3298. Re-derives one seller''s ledger from their sales, expenses, payouts, mileage and home office. Clears its account-code scratch table with TRUNCATE: production loads safeupdate, which rejects a WHERE-less DELETE with SQLSTATE 21000, and the DELETE this replaces meant the function had never completed a run in production since 00685.';

insert into public.applied_migrations (version) values ('00777') on conflict do nothing;
