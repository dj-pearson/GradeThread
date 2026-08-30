-- US-2990: the home office, simplified method.
--
-- A reseller storing inventory in a spare room has a deduction most of them
-- never take, because the rules read as complicated. The simplified method is
-- square feet times a rate, capped, prorated by months used -- one screen of
-- arithmetic. The complicated version (Form 8829, actual expenses, depreciation
-- recapture on sale) is deliberately NOT built: it needs mortgage interest,
-- insurance, utilities and a basis calculation, and getting it wrong is worse
-- than not offering it.
--
-- THE RATE AND THE CAP ARE DATED DATA (AC2), for the same reason the mileage
-- rate is: they are set by the IRS, they can change, and a constant that is
-- edited silently reprices every year a seller has already filed.
--
-- SCHEDULE C LINE 30, WHICH IS NOT LINE 28. The form keeps the home office out
-- of total expenses: line 28 is expenses, line 29 is profit before the home
-- office, line 30 is the home office, line 31 is what you are taxed on. The P&L
-- was folding it into line 28 until this story; a seller transcribing that
-- subtotal would have overstated it by the whole deduction.
--
-- The rules are in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.home_office_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from  date NOT NULL,
  effective_to    date,

  cents_per_sq_ft integer NOT NULL,
  max_sq_ft       integer NOT NULL,

  is_provisional  boolean NOT NULL DEFAULT false,
  note            text NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.home_office_rates
    ADD CONSTRAINT home_office_rates_range_check
      CHECK (effective_to IS NULL OR effective_to > effective_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS home_office_rates_from_idx
  ON public.home_office_rates (effective_from);

ALTER TABLE public.home_office_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone may read home office rates"
  ON public.home_office_rates;
CREATE POLICY "Anyone may read home office rates"
  ON public.home_office_rates FOR SELECT USING (true);

-- $5.00 a square foot, capped at 300 square feet, i.e. $1,500 a year. That has
-- been the simplified method since it was introduced for the 2013 tax year and
-- has not changed since -- which is exactly why it is in a table: a number that
-- has not moved in a decade is the one nobody thinks to check when it does.
INSERT INTO public.home_office_rates
  (effective_from, effective_to, cents_per_sq_ft, max_sq_ft, is_provisional, note)
VALUES
  ('2013-01-01', NULL, 500, 300, false,
   '$5.00 per square foot, up to 300 square feet, so $1,500 a year at most. The IRS simplified option, unchanged since the 2013 tax year. Check the current figure before filing.')
ON CONFLICT (effective_from) DO UPDATE SET
  effective_to    = EXCLUDED.effective_to,
  cents_per_sq_ft = EXCLUDED.cents_per_sq_ft,
  max_sq_ft       = EXCLUDED.max_sq_ft,
  is_provisional  = EXCLUDED.is_provisional,
  note            = EXCLUDED.note,
  updated_at      = now();


CREATE TABLE IF NOT EXISTS public.home_office_years (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tax_year     integer NOT NULL,

  -- Regularly AND exclusively. The screen says what that means in a sentence;
  -- the number here is the seller's answer to it, not our judgement of it.
  square_feet  numeric(7,1) NOT NULL DEFAULT 0,
  months_used  integer NOT NULL DEFAULT 12,

  -- 'simplified' or 'actual'. Only the simplified method produces a ledger
  -- entry: actual expenses need Form 8829 and a basis calculation this app does
  -- not do, and a seller on that method is told so rather than shown a figure
  -- that does not apply to them.
  method       text NOT NULL DEFAULT 'simplified',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tax_year)
);

DO $$ BEGIN
  ALTER TABLE public.home_office_years
    ADD CONSTRAINT home_office_method_check
      CHECK (method IN ('simplified', 'actual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.home_office_years
    ADD CONSTRAINT home_office_months_check
      CHECK (months_used BETWEEN 0 AND 12);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.home_office_years
    ADD CONSTRAINT home_office_sqft_check
      CHECK (square_feet >= 0 AND square_feet < 100000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS set_home_office_years_updated_at
  ON public.home_office_years;
CREATE TRIGGER set_home_office_years_updated_at
  BEFORE UPDATE ON public.home_office_years
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.home_office_years ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own home office" ON public.home_office_years;
CREATE POLICY "Users can view own home office"
  ON public.home_office_years FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own home office" ON public.home_office_years;
CREATE POLICY "Users can create own home office"
  ON public.home_office_years FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own home office" ON public.home_office_years;
CREATE POLICY "Users can update own home office"
  ON public.home_office_years FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own home office" ON public.home_office_years;
CREATE POLICY "Users can delete own home office"
  ON public.home_office_years FOR DELETE USING ((select auth.uid()) = user_id);


-- ── The arithmetic ─────────────────────────────────────────────────────────
--
-- IMMUTABLE would be wrong: it reads home_office_rates, and a rate correction
-- must change the answer. STABLE is the honest marker.
CREATE OR REPLACE FUNCTION public.home_office_deduction_cents(
  p_square_feet numeric,
  p_months_used integer,
  p_tax_year    integer
)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT coalesce(
    (SELECT
       -- Cap FIRST, prorate SECOND. The cap is on the square footage, not on
       -- the answer: 400 sq ft for six months is 300 capped then halved, which
       -- is $750 -- not $1,500 halved from an uncapped $2,000, and not $1,500
       -- because the uncapped figure exceeded it. The order is the difference
       -- between $750 and $1,000.
       round(least(p_square_feet, r.max_sq_ft) * r.cents_per_sq_ft
             * greatest(least(p_months_used, 12), 0) / 12.0)::bigint
       FROM public.home_office_rates r
      WHERE r.effective_from <= make_date(p_tax_year, 12, 31)
        AND (r.effective_to IS NULL OR r.effective_to > make_date(p_tax_year, 1, 1))
      ORDER BY r.effective_from DESC
      LIMIT 1),
    0);
$fn$;

grant execute on function public.home_office_deduction_cents(numeric, integer, integer)
  to authenticated;
grant execute on function public.home_office_deduction_cents(numeric, integer, integer)
  to service_role;


-- ── The double-count guard (AC3) ───────────────────────────────────────────
--
-- The simplified method REPLACES the rent, utilities and insurance you would
-- otherwise apportion. A seller claiming it AND expensing rent on the same
-- space is deducting the same thing twice, and neither figure looks wrong on
-- its own -- which is why this is a query rather than a note on a screen.
--
-- It reports what it found rather than deciding. A seller with a home office
-- AND a genuinely separate storage unit is fine, and the app cannot tell the
-- two apart; the seller can, once both numbers are in front of them.
CREATE OR REPLACE FUNCTION public.home_office_overlap(p_tax_year integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH bounds AS (
    SELECT make_date(p_tax_year, 1, 1) AS from_d,
           make_date(p_tax_year + 1, 1, 1) AS to_d
  ),
  office AS (
    SELECT square_feet, months_used, method
      FROM public.home_office_years
     WHERE tax_year = p_tax_year
     LIMIT 1
  ),
  rent AS (
    SELECT coalesce(-sum(e.amount_cents), 0) AS cents, count(*)::integer AS entries
      FROM public.ledger_entries e
      JOIN public.ledger_accounts a ON a.id = e.account_id
      CROSS JOIN bounds b
     WHERE a.code = 'rent_property'
       AND e.entry_date >= b.from_d AND e.entry_date < b.to_d
  ),
  utilities AS (
    SELECT coalesce(-sum(e.amount_cents), 0) AS cents, count(*)::integer AS entries
      FROM public.ledger_entries e
      JOIN public.ledger_accounts a ON a.id = e.account_id
      CROSS JOIN bounds b
     WHERE a.code = 'utilities'
       AND e.entry_date >= b.from_d AND e.entry_date < b.to_d
  )
  SELECT jsonb_build_object(
    'tax_year', p_tax_year,
    'has_home_office', (SELECT count(*) FROM office WHERE square_feet > 0) > 0,
    'method', (SELECT method FROM office),
    'square_feet', (SELECT square_feet FROM office),
    'deduction_cents', coalesce(
      (SELECT public.home_office_deduction_cents(square_feet, months_used, p_tax_year)
         FROM office WHERE method = 'simplified'), 0),
    'rent_cents', (SELECT cents FROM rent),
    'rent_entries', (SELECT entries FROM rent),
    'utilities_cents', (SELECT cents FROM utilities),
    'utilities_entries', (SELECT entries FROM utilities),
    'overlaps',
      (SELECT count(*) FROM office WHERE square_feet > 0) > 0
      AND ((SELECT entries FROM rent) > 0 OR (SELECT entries FROM utilities) > 0)
  );
$fn$;

grant execute on function public.home_office_overlap(integer) to authenticated;
grant execute on function public.home_office_overlap(integer) to service_role;


-- ── The ledger, with the home office folded in ─────────────────────────────
--
-- 00695's function plus ONE new block. Reproduced in full because
-- CREATE OR REPLACE takes a whole body; the US-3002 authorization check, the
-- US-2987 tax branches and the US-2989 mileage join are all carried forward
-- unchanged and are all load-bearing.

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
  DELETE FROM _acct;
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

comment on table public.home_office_years is
  'US-2990 the simplified home-office deduction: square feet used regularly and exclusively, months used, and the election. Only the simplified method produces a ledger entry; actual expenses need Form 8829, which this app does not do.';
comment on function public.home_office_overlap(integer) is
  'US-2990 AC3. Reports a home office claimed alongside rent or utilities expensed separately -- the same space deducted twice, where neither figure looks wrong alone. It reports; it does not decide, because a genuinely separate storage unit is legitimate and only the seller can tell.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00697') on conflict do nothing;
