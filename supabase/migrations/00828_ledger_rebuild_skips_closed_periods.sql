-- 00828_ledger_rebuild_skips_closed_periods.sql
--
-- rebuild_ledger_for_user no longer rewrites entries inside a closed period.
--
-- 00777 deleted every non-adjustment ledger row for the seller and re-derived
-- all of them, closed periods included. The 00702 lock triggers cover only
-- flipdesk_expenses, mileage_trips, sales and inventory_items.acquired_price.
-- The rebuild also reads home_office_years, shipments, ebay_payouts and
-- mileage_rates, and none of those is locked. So a changed home-office year,
-- a late payout or a corrected mileage rate moved a closed year's ledger away
-- from the closing_figures stored for it, silently, on the next rebuild.
--
-- The fix skips the dates rather than locking more tables, so an input added
-- later is covered without another trigger. A closed period is a
-- closed_periods row with reopened_at IS NULL, which is exactly what
-- is_period_closed() answers:
--   * the DELETE keeps rows whose entry_date is inside a closed period;
--   * every INSERT skips rows whose date is inside one;
--   * every INSERT is ON CONFLICT DO NOTHING. After the DELETE the only rows
--     left are adjustments (their own source_kind) and the kept closed-period
--     rows, so a conflict can only mean a source whose date moved OUT of a
--     closed period. The closed entry wins until the period is reopened, and
--     the next rebuild after a reopen re-derives it from the source.
--
-- Reopening a period (reopen_period sets reopened_at) makes its dates
-- rebuildable again, which is the escape hatch 00702 already names.
--
-- Everything else is carried forward from 00777 byte for byte: the US-3002
-- body guard, the US-3298 TRUNCATE (production loads safeupdate), the tax
-- branches, mileage, home office and payouts. NO REVOKE (US-2403); the grants
-- are re-issued. Same signature, replaced in place. Idempotent.
--
-- Rules: vault/50-business/books-and-taxes.md.

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

  -- 00828: entries dated inside a CLOSED period are kept as they stand. The
  -- figures there were frozen on close, and a rebuild must not move them.
  DELETE FROM public.ledger_entries
   WHERE user_id = p_user_id AND source_kind <> 'adjustment'
     AND NOT public.is_period_closed(p_user_id, entry_date);

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
  JOIN _acct a ON a.code = e.code
  -- 00828: nothing is re-derived into a closed period. See the DELETE above.
  WHERE NOT public.is_period_closed(p_user_id, e.d)
  ON CONFLICT DO NOTHING;

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
   WHERE x.user_id = p_user_id AND x.amount <> 0
     AND NOT public.is_period_closed(p_user_id, x.spent_on)
  ON CONFLICT DO NOTHING;

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
   WHERE t.user_id = p_user_id AND t.miles > 0
     AND NOT public.is_period_closed(p_user_id, t.trip_date)
  ON CONFLICT DO NOTHING;

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
            h.square_feet, h.months_used, h.tax_year) > 0
     AND NOT public.is_period_closed(p_user_id, make_date(h.tax_year, 12, 31))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.ledger_entries
    (user_id, entry_date, account_id, amount_cents, currency, memo,
     source_kind, source_id, source_detail)
  SELECT p_user_id, p.payout_date::date, a.id, p.amount_cents,
         coalesce(p.currency, 'USD'),
         'Payout ' || p.payout_id, 'payout', p.id, 'payout'
    FROM public.ebay_payouts p
    JOIN _acct a ON a.code = 'cash_payout'
   WHERE p.user_id = p_user_id
     AND p.amount_cents IS NOT NULL AND p.payout_date IS NOT NULL
     AND NOT public.is_period_closed(p_user_id, p.payout_date::date)
  ON CONFLICT DO NOTHING;

  RETURN (SELECT count(*)::integer FROM public.ledger_entries
           WHERE user_id = p_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebuild_ledger_for_user(uuid) TO public;
GRANT EXECUTE ON FUNCTION public.rebuild_ledger_for_user(uuid) TO service_role;

comment on function public.rebuild_ledger_for_user(uuid) is
  '00828. Re-derives one seller''s ledger from their sales, expenses, payouts, mileage and home office, except entries dated inside a closed period (closed_periods row with reopened_at IS NULL), which are kept so a rebuild cannot move figures already frozen on close. Clears its account-code scratch table with TRUNCATE because production loads safeupdate (US-3298).';

insert into public.applied_migrations (version) values ('00828') on conflict do nothing;
