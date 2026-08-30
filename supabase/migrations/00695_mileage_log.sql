-- US-2989: a mileage log the IRS would accept, not an expense category called
-- mileage.
--
-- expense_category has carried a 'mileage' value since 00019, so today a seller
-- types a dollar amount they worked out themselves. The standard mileage
-- deduction needs the DATE, the MILES, the DESTINATION and the BUSINESS PURPOSE,
-- recorded at or near the time of the trip -- a reconstructed log is exactly
-- what the IRS discounts. A reseller sourcing at thrift stores twice a week is
-- throwing away a four-figure deduction because logging it is tedious.
--
-- WHY THE RATE IS A TABLE AND NOT A CONSTANT (AC2). The rate changes every year
-- and it has changed MID-year: 2022 ran at 58.5 cents to June 30 and 62.5 cents
-- from July 1. A constant cannot express that, and a constant that is edited
-- silently reprices every trip a seller ever logged. Lookup is by DATE, not
-- snapshotted onto the trip, so a corrected rate flows through rather than being
-- frozen into rows nobody revisits.
--
-- THE UNIT IS IN THE COLUMN NAME, and that is not fussiness. Most published
-- rates are not whole cents -- 58.5, 62.5, 65.5 -- so a `cents_per_mile integer`
-- cannot hold them, and putting 585 in a column called cents means five dollars
-- eighty-five a mile: an eight-fold overstatement that looks plausible on a
-- summary and absurd only on a big year. The column holds TENTHS OF A CENT.
--
-- The rates below are the IRS business standard mileage rates. They are DATA,
-- not advice, and every row's note says to check the IRS notice before filing.
-- The rules are in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.mileage_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from date NOT NULL,
  effective_to   date,

  -- TENTHS OF A CENT per mile. 58.5 cents is 585; 70 cents is 700.
  tenths_of_cent_per_mile integer NOT NULL,

  -- TRUE when the rate is carried forward rather than published. Today is 2026
  -- and the 2026 notice was not out when this shipped, so a seller logging a
  -- trip today would otherwise get nothing at all. Carrying the last known rate
  -- forward and SAYING SO beats both alternatives: a silent zero and a silent
  -- guess.
  is_provisional boolean NOT NULL DEFAULT false,
  note           text NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.mileage_rates
    ADD CONSTRAINT mileage_rates_range_check
      CHECK (effective_to IS NULL OR effective_to > effective_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.mileage_rates
    ADD CONSTRAINT mileage_rates_positive_check
      CHECK (tenths_of_cent_per_mile > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS mileage_rates_from_idx
  ON public.mileage_rates (effective_from);

ALTER TABLE public.mileage_rates ENABLE ROW LEVEL SECURITY;

-- Reference data, like the chart of accounts and the facilitator rules:
-- readable by everyone, writable by nobody through RLS. No user_id, nothing to
-- scope, nothing to leak.
DROP POLICY IF EXISTS "Anyone may read mileage rates" ON public.mileage_rates;
CREATE POLICY "Anyone may read mileage rates"
  ON public.mileage_rates FOR SELECT USING (true);

INSERT INTO public.mileage_rates
  (effective_from, effective_to, tenths_of_cent_per_mile, is_provisional, note)
VALUES
  ('2021-01-01', '2022-01-01', 560, false,
   '56.0 cents. IRS business standard mileage rate for 2021. Check the IRS notice before filing.'),
  ('2022-01-01', '2022-07-01', 585, false,
   '58.5 cents. IRS business standard mileage rate for the first half of 2022. The rate changed MID-YEAR, which is why this table is keyed on dates rather than years.'),
  ('2022-07-01', '2023-01-01', 625, false,
   '62.5 cents. IRS business standard mileage rate from 1 July 2022.'),
  ('2023-01-01', '2024-01-01', 655, false,
   '65.5 cents. IRS business standard mileage rate for 2023.'),
  ('2024-01-01', '2025-01-01', 670, false,
   '67.0 cents. IRS business standard mileage rate for 2024.'),
  ('2025-01-01', '2026-01-01', 700, false,
   '70.0 cents. IRS business standard mileage rate for 2025.'),
  ('2026-01-01', NULL, 700, true,
   'PROVISIONAL, carried forward from 2025 because the IRS had not published the 2026 rate when this shipped. Confirm the published rate before filing and update this row when it is announced.')
ON CONFLICT (effective_from) DO UPDATE SET
  effective_to            = EXCLUDED.effective_to,
  tenths_of_cent_per_mile = EXCLUDED.tenths_of_cent_per_mile,
  is_provisional          = EXCLUDED.is_provisional,
  note                    = EXCLUDED.note,
  updated_at              = now();

comment on column public.mileage_rates.tenths_of_cent_per_mile is
  'US-2989 TENTHS OF A CENT per mile. 58.5 cents is 585, 70 cents is 700. The unit is in the name because an integer cents column cannot hold most of the rates the IRS has actually published.';


CREATE TABLE IF NOT EXISTS public.mileage_trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  trip_date    date NOT NULL,
  miles        numeric(8,1) NOT NULL,

  -- The four things the IRS asks for. `purpose` is NOT NULL with no default:
  -- "business" is not a purpose, and a log full of blanks is the reconstructed
  -- record that gets discounted.
  purpose      text NOT NULL,
  start_location text,
  end_location   text,
  round_trip   boolean NOT NULL DEFAULT false,

  -- What the trip was for, when it is known. ON DELETE SET NULL both ways: a
  -- deleted source must not erase a trip that really happened.
  source_id    uuid REFERENCES public.sources(id) ON DELETE SET NULL,
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.mileage_trips
    ADD CONSTRAINT mileage_trips_miles_check CHECK (miles > 0 AND miles < 100000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.mileage_trips
    ADD CONSTRAINT mileage_trips_purpose_check CHECK (btrim(purpose) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_mileage_trips_user_date
  ON public.mileage_trips(user_id, trip_date DESC);
CREATE INDEX IF NOT EXISTS idx_mileage_trips_source
  ON public.mileage_trips(source_id) WHERE source_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_mileage_trips_updated_at ON public.mileage_trips;
CREATE TRIGGER set_mileage_trips_updated_at
  BEFORE UPDATE ON public.mileage_trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.mileage_trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own trips" ON public.mileage_trips;
CREATE POLICY "Users can view own trips"
  ON public.mileage_trips FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own trips" ON public.mileage_trips;
CREATE POLICY "Users can create own trips"
  ON public.mileage_trips FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own trips" ON public.mileage_trips;
CREATE POLICY "Users can update own trips"
  ON public.mileage_trips FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own trips" ON public.mileage_trips;
CREATE POLICY "Users can delete own trips"
  ON public.mileage_trips FOR DELETE USING ((select auth.uid()) = user_id);


-- Schedule C Part IV, and the standard-versus-actual election.
--
-- Part IV asks for total miles, commuting miles and other personal miles. None
-- of those is derivable from a business-trip log -- only the seller knows them --
-- so they are entered once a year and stored beside the election.
CREATE TABLE IF NOT EXISTS public.vehicle_use_years (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tax_year     integer NOT NULL,

  -- AC6. Standard rate OR actual expenses, never both. Per year, because it is
  -- a per-year election, and shown on the screen so a seller can see which one
  -- their numbers are built on.
  method       text NOT NULL DEFAULT 'standard',

  total_miles          numeric(9,1),
  commuting_miles      numeric(9,1),
  other_personal_miles numeric(9,1),
  placed_in_service_on date,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tax_year)
);

DO $$ BEGIN
  ALTER TABLE public.vehicle_use_years
    ADD CONSTRAINT vehicle_method_check CHECK (method IN ('standard', 'actual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS set_vehicle_use_years_updated_at ON public.vehicle_use_years;
CREATE TRIGGER set_vehicle_use_years_updated_at
  BEFORE UPDATE ON public.vehicle_use_years
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vehicle_use_years ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own vehicle year" ON public.vehicle_use_years;
CREATE POLICY "Users can view own vehicle year"
  ON public.vehicle_use_years FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own vehicle year" ON public.vehicle_use_years;
CREATE POLICY "Users can create own vehicle year"
  ON public.vehicle_use_years FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own vehicle year" ON public.vehicle_use_years;
CREATE POLICY "Users can update own vehicle year"
  ON public.vehicle_use_years FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own vehicle year" ON public.vehicle_use_years;
CREATE POLICY "Users can delete own vehicle year"
  ON public.vehicle_use_years FOR DELETE USING ((select auth.uid()) = user_id);


-- ── Reading it ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mileage_rate_on(p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'tenths_of_cent_per_mile', r.tenths_of_cent_per_mile,
    'is_provisional', r.is_provisional,
    'note', r.note,
    'effective_from', r.effective_from
  )
  FROM public.mileage_rates r
  WHERE r.effective_from <= p_date
    AND (r.effective_to IS NULL OR r.effective_to > p_date)
  ORDER BY r.effective_from DESC
  LIMIT 1;
$fn$;

grant execute on function public.mileage_rate_on(date) to authenticated;
grant execute on function public.mileage_rate_on(date) to service_role;

-- The log total, and the things the screen has to disclose about it.
CREATE OR REPLACE FUNCTION public.mileage_summary(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH valued AS (
    SELECT t.id, t.miles, t.trip_date,
           r.tenths_of_cent_per_mile, r.is_provisional
      FROM public.mileage_trips t
      LEFT JOIN LATERAL (
        SELECT tenths_of_cent_per_mile, is_provisional
          FROM public.mileage_rates
         WHERE effective_from <= t.trip_date
           AND (effective_to IS NULL OR effective_to > t.trip_date)
         ORDER BY effective_from DESC LIMIT 1
      ) r ON true
     WHERE t.trip_date >= p_from AND t.trip_date < p_to
  )
  SELECT jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'trip_count', (SELECT count(*) FROM valued),
    'total_miles', coalesce((SELECT sum(miles) FROM valued), 0),
    -- ROUNDED PER TRIP, then summed -- deliberately, and it is the opposite of
    -- what I wrote first.
    --
    -- Rounding once on the total is more precise in isolation and is WRONG
    -- here, because the ledger writes one entry per trip and rounds each. Two
    -- 10.4-mile trips at 58.5 cents are 608.4 cents each: 1216 rounded per trip,
    -- 1217 rounded once. That one-cent gap between this summary and the ledger
    -- was reproduced on Postgres before this comment was written, and a seller
    -- who finds two of our own screens disagreeing by a cent stops believing
    -- both. The ledger is the record; this matches it by construction.
    'deduction_cents',
      coalesce((SELECT sum(round(miles * tenths_of_cent_per_mile / 10))
                  FROM valued WHERE tenths_of_cent_per_mile IS NOT NULL), 0),
    'trips_without_a_rate',
      (SELECT count(*) FROM valued WHERE tenths_of_cent_per_mile IS NULL),
    'trips_on_a_provisional_rate',
      (SELECT count(*) FROM valued WHERE is_provisional),
    'miles_on_a_provisional_rate',
      coalesce((SELECT sum(miles) FROM valued WHERE is_provisional), 0)
  );
$fn$;

grant execute on function public.mileage_summary(date, date) to authenticated;
grant execute on function public.mileage_summary(date, date) to service_role;


-- ── The ledger, with mileage folded in ─────────────────────────────────────
--
-- 00691's function plus ONE new block. Reproduced in full because
-- CREATE OR REPLACE takes a whole body; the US-3002 authorization check and the
-- US-2987 tax branches are carried forward unchanged and are both load-bearing.

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

comment on table public.mileage_trips is
  'US-2989 a contemporaneous business-mileage log: date, miles, purpose and where. Valued at the rate in force on the trip date, looked up rather than snapshotted, so a corrected rate flows through and last year cannot silently reprice.';
comment on table public.vehicle_use_years is
  'US-2989 Schedule C Part IV: total, commuting and other personal miles, none of which is derivable from a business-trip log. Also carries the standard-versus-actual election, which is per year and never both.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00695') on conflict do nothing;
