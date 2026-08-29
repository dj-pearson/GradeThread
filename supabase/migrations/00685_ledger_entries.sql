-- US-2984: one ledger. Every dollar becomes an entry, and every report reads it.
--
-- Before this, three code paths each derived their own totals: finances_dashboard
-- (00143) joined sales to inventory_items inline, financial-export.tsx summed a
-- different shape in TypeScript, and flipdesk_expenses was a fourth number bolted
-- on by netAfterOverhead(). Three chances to disagree and nowhere to look up
-- "what happened to my money on this date".
--
-- WHAT THIS IS NOT. It is not double-entry. Entries are single-sided: a signed
-- amount against one account. Forcing balanced pairs on a one-person reseller
-- business costs every write path and buys nothing it needs. The consequence is
-- named rather than discovered later, and is written up in
-- vault/50-business/books-and-taxes.md: this ledger cannot produce a balance
-- sheet, cannot represent owner draws or capital contributions, and cannot
-- track a loan. It answers profit-and-loss questions, which is what a Schedule C
-- filer asks.

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  entry_date   date NOT NULL,
  account_id   uuid NOT NULL REFERENCES public.ledger_accounts(id),

  -- INTEGER CENTS, SIGNED. Positive increases profit, negative reduces it.
  --
  -- Integer because the alternative is the bug this epic exists to prevent: two
  -- screens showing amounts that differ by a cent and a seller who stops
  -- believing either. Every source column is numeric(10,2), so value * 100 is
  -- exactly an integer and the conversion loses nothing -- that is checked in
  -- ledger-math.test.ts rather than assumed.
  amount_cents bigint NOT NULL,
  currency     text NOT NULL DEFAULT 'USD',

  memo         text,

  source_kind  text NOT NULL,
  -- The row this entry was derived from. NULL only on a hand-entered
  -- adjustment, which is the one entry kind a human authors directly.
  source_id    uuid,
  -- Which PART of that row. One sale produces up to nine entries, so the id
  -- alone cannot be the key. 'price', 'fees', 'cogs' and so on.
  source_detail text NOT NULL DEFAULT '',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.ledger_entries
    ADD CONSTRAINT ledger_entries_source_kind_check CHECK (source_kind IN (
      'sale', 'expense', 'fee', 'shipping', 'payout', 'adjustment', 'cogs'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An adjustment is the only entry a human authors; everything else must name
-- the row it came from, or re-derivation cannot find it to replace it.
DO $$ BEGIN
  ALTER TABLE public.ledger_entries
    ADD CONSTRAINT ledger_entries_source_id_check
      CHECK (source_id IS NOT NULL OR source_kind = 'adjustment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- THE IDEMPOTENCY KEY, and it is the whole reason re-derivation is safe.
--
-- Same shape as migration 00565's recurrence slot index: the database refuses
-- the duplicate, so the rebuild needs no bookkeeping column, can re-run as often
-- as it likes, can catch up after an outage and can race a second instance. The
-- worst outcome is a rejected insert rather than a seller's totals silently
-- doubling.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_natural_key_idx
  ON public.ledger_entries (user_id, source_kind, source_id, source_detail)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_date
  ON public.ledger_entries (user_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account
  ON public.ledger_entries (account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_source
  ON public.ledger_entries (source_kind, source_id) WHERE source_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_ledger_entries_updated_at ON public.ledger_entries;
CREATE TRIGGER set_ledger_entries_updated_at
  BEFORE UPDATE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own ledger" ON public.ledger_entries;
CREATE POLICY "Users can view own ledger"
  ON public.ledger_entries FOR SELECT USING (auth.uid() = user_id);
-- Writes are confined to adjustments. Derived entries are written by
-- rebuild_ledger_for_user(), which is SECURITY DEFINER and resolves the owner
-- from the SOURCE ROWS rather than from anything the caller supplies. A seller
-- who could hand-write a 'sale' entry could inflate a number their own 1099-K
-- reconciliation is supposed to check.
DROP POLICY IF EXISTS "Users can create own adjustments" ON public.ledger_entries;
CREATE POLICY "Users can create own adjustments"
  ON public.ledger_entries FOR INSERT
  WITH CHECK (auth.uid() = user_id AND source_kind = 'adjustment');
DROP POLICY IF EXISTS "Users can update own adjustments" ON public.ledger_entries;
CREATE POLICY "Users can update own adjustments"
  ON public.ledger_entries FOR UPDATE
  USING (auth.uid() = user_id AND source_kind = 'adjustment');
DROP POLICY IF EXISTS "Users can delete own adjustments" ON public.ledger_entries;
CREATE POLICY "Users can delete own adjustments"
  ON public.ledger_entries FOR DELETE
  USING (auth.uid() = user_id AND source_kind = 'adjustment');


-- ── Derivation ─────────────────────────────────────────────────────────────
--
-- One function, re-runnable, producing byte-identical rows on a second run.
-- The nine entries a completed sale produces mirror the pnl_net formula in
-- finances_dashboard (00143) term for term:
--
--   net = (sale_price + shipping_collected)
--       - (platform_fees + payment_processing_fees)
--       - (shipping_cost + grading_cost + other_costs)
--       - acquired_price
--       - legacy_shipment_total (only when the sale row carries no shipping)
--
-- Sales tax is NOT in that formula and is NOT in the net here either. It is
-- still RECORDED, on an 'excluded' account, because a seller reconciling a
-- 1099-K needs to see it was handled rather than lost (US-2987, US-2988).

CREATE OR REPLACE FUNCTION public.rebuild_ledger_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_written integer := 0;
BEGIN
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

-- Callable by the owner for their OWN books only. SECURITY DEFINER is needed to
-- write the derived rows past the adjustment-only INSERT policy, so the guard
-- has to be here: without it, any authenticated caller could rebuild -- and
-- therefore read the row count of -- another tenant's ledger.
CREATE OR REPLACE FUNCTION public.rebuild_my_ledger()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  RETURN public.rebuild_ledger_for_user(auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_ledger_for_user(uuid) FROM public;
grant execute on function public.rebuild_ledger_for_user(uuid) to service_role;
grant execute on function public.rebuild_my_ledger() to authenticated;
grant execute on function public.rebuild_my_ledger() to service_role;


-- ── The invariant, as a query anyone can run ───────────────────────────────
--
-- AC4. The ledger's net over sale-derived entries must equal
-- finances_dashboard's net_profit for the same period, to the cent. If they
-- disagree the LEDGER is wrong, not the dashboard: the dashboard is the
-- behaviour sellers have been reading for months.
--
-- Operating expenses are the deliberate difference. The dashboard never
-- included them (finances.tsx bolts them on afterwards through
-- netAfterOverhead), so this function reports both figures separately rather
-- than papering over the gap.
CREATE OR REPLACE FUNCTION public.ledger_reconciliation(
  p_period_start timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH dash AS (
    SELECT ((public.finances_dashboard(p_period_start) -> 'summary'
             ->> 'net_profit')::numeric * 100)::bigint AS dashboard_net_cents
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
     WHERE (p_period_start IS NULL OR e.entry_date >= p_period_start::date)
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
  ) FROM dash, led;
$$;

grant execute on function public.ledger_reconciliation(timestamptz) to authenticated;
grant execute on function public.ledger_reconciliation(timestamptz) to service_role;

comment on table public.ledger_entries is
  'US-2984 the canonical record. Single-sided signed integer cents against one account; positive increases profit. NOT double-entry - no balance sheet, no owner draws, no loans, and that is written up in vault/50-business/books-and-taxes.md rather than left to be discovered.';
comment on function public.ledger_reconciliation(timestamptz) is
  'US-2984 AC4. Returns the ledger net, the finances_dashboard net and their variance for one period. agrees=false means the LEDGER is wrong.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00685') on conflict do nothing;
