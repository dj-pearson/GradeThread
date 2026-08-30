-- US-2987: marketplace facilitator sales tax is not your income, and which
-- platforms are facilitators is a FACT THAT CHANGES.
--
-- Since 00685 the ledger has booked every sale's `tax` to the excluded account
-- unconditionally. That is right for eBay, Poshmark, Mercari and the rest --
-- under marketplace facilitator law the platform collects the tax and remits it,
-- so it was never the seller's income. It is WRONG for a seller running their
-- own storefront in a state where they have nexus: there the seller IS the
-- retailer, the tax they collect is part of their gross receipts (Schedule C
-- line 1) and the tax they pay over is a deduction (line 23). Booking it as
-- excluded understates income, which understates tax -- the direction that gets
-- a seller in trouble rather than the direction that costs them money.
--
-- AC3 is why this is a table and not a CASE expression: facilitator law arrived
-- state by state between 2018 and 2021, platforms change their handling, and a
-- rule with no effective date cannot answer a question about 2022.
--
-- The rules, and what happens when the platform is unknown, are in
-- vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.marketplace_facilitator_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform      public.listing_platform NOT NULL,

  -- NULL means "everywhere". State-level rules are possible and none is seeded:
  -- `sales` carries no buyer state, so nothing could read one yet. The column
  -- exists so a future state rule does not need a migration that rewrites every
  -- row, and its absence is recorded rather than implied.
  state         text,

  effective_from date NOT NULL,
  effective_to   date,

  is_facilitator boolean NOT NULL,

  -- Why this rule says what it says. Not decoration: the next person to touch
  -- this table needs to know whether a row is a legal fact or a guess.
  note          text NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.marketplace_facilitator_rules
    ADD CONSTRAINT facilitator_state_check
      CHECK (state IS NULL OR state ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.marketplace_facilitator_rules
    ADD CONSTRAINT facilitator_range_check
      CHECK (effective_to IS NULL OR effective_to > effective_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One rule per platform per state per start date. The upsert below keys on it,
-- so a wording or date correction ships as an ordinary migration.
CREATE UNIQUE INDEX IF NOT EXISTS facilitator_rule_key_idx
  ON public.marketplace_facilitator_rules
     (platform, coalesce(state, '*'), effective_from);

DROP TRIGGER IF EXISTS set_facilitator_rules_updated_at
  ON public.marketplace_facilitator_rules;
CREATE TRIGGER set_facilitator_rules_updated_at
  BEFORE UPDATE ON public.marketplace_facilitator_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketplace_facilitator_rules ENABLE ROW LEVEL SECURITY;

-- Reference data, like the chart of accounts: readable by everyone, writable by
-- nobody through RLS. There is no user_id here at all, so there is nothing to
-- scope and nothing to leak -- these are published facts about platforms.
DROP POLICY IF EXISTS "Anyone may read facilitator rules"
  ON public.marketplace_facilitator_rules;
CREATE POLICY "Anyone may read facilitator rules"
  ON public.marketplace_facilitator_rules FOR SELECT USING (true);


-- ── The rules ──────────────────────────────────────────────────────────────
--
-- 2021-07-01 is the date every state with a sales tax had a marketplace
-- facilitator law in force (Missouri, the last, took effect 2023-01-01, and
-- Florida and Kansas in 2021). A single national start date is deliberately
-- COARSER than the law: a 2019 sale on a platform in a state that had not yet
-- passed one would be mis-booked. That is recorded here rather than hidden,
-- because the alternative -- fifty rows per platform -- claims a precision the
-- `sales` table cannot support, since it carries no buyer state.

INSERT INTO public.marketplace_facilitator_rules
  (platform, state, effective_from, effective_to, is_facilitator, note)
VALUES
  ('ebay',     NULL, '2021-07-01', NULL, true,
   'eBay collects and remits sales tax as a marketplace facilitator in every US state that imposes one. The amount appears in the seller''s 1099-K gross and is not their income.'),
  ('poshmark', NULL, '2021-07-01', NULL, true,
   'Poshmark collects and remits as a marketplace facilitator.'),
  ('mercari',  NULL, '2021-07-01', NULL, true,
   'Mercari collects and remits as a marketplace facilitator.'),
  ('depop',    NULL, '2021-07-01', NULL, true,
   'Depop collects and remits as a marketplace facilitator.'),
  ('grailed',  NULL, '2021-07-01', NULL, true,
   'Grailed collects and remits as a marketplace facilitator.'),
  ('etsy',     NULL, '2021-07-01', NULL, true,
   'Etsy collects and remits as a marketplace facilitator.'),
  ('facebook', NULL, '2021-07-01', NULL, true,
   'Facebook Marketplace collects and remits on checkout orders. A local cash pickup arranged through Facebook is not a checkout order and carries no tax at all, so this rule never applies to one.'),
  ('offerup',  NULL, '2021-07-01', NULL, true,
   'OfferUp collects and remits on shipped orders.'),
  ('whatnot',  NULL, '2021-07-01', NULL, true,
   'Whatnot collects and remits as a marketplace facilitator.'),
  ('vinted',   NULL, '2021-07-01', NULL, true,
   'Vinted collects and remits as a marketplace facilitator.'),

  -- The two that are NOT, and this is the whole reason the table exists.
  ('shopify',  NULL, '2018-01-01', NULL, false,
   'Shopify is a platform, NOT a marketplace facilitator. A seller running their own Shopify store is the retailer: tax they collect is part of their gross receipts and the tax they remit is a deduction. Shopify Tax calculates it; it does not file it.'),
  ('other',    NULL, '2018-01-01', NULL, false,
   'Unknown channel. Treated as seller-collected, which is the CONSERVATIVE answer: it books the tax into income rather than out of it, so a mistake here overstates income rather than understating it. Overstating is a number the seller can dispute; understating is one the IRS disputes.')
ON CONFLICT (platform, coalesce(state, '*'), effective_from) DO UPDATE SET
  is_facilitator = EXCLUDED.is_facilitator,
  effective_to   = EXCLUDED.effective_to,
  note           = EXCLUDED.note,
  updated_at     = now();


-- ── The account the non-facilitator case needs ─────────────────────────────
--
-- Added here rather than in 00684, which is applied in production and therefore
-- immutable. The chart's seed is an upsert keyed on `code`, so a later migration
-- adding a row is the supported way to extend it -- and
-- src/lib/chart-of-accounts.test.ts parses EVERY migration that seeds the table,
-- not just the first, so the mirror cannot drift by growing.
INSERT INTO public.ledger_accounts
  (code, name, flow, schedule_c_part, schedule_c_line, schedule_c_label,
   no_line_reason, is_system, sort_order)
VALUES
  ('sales_tax_remitted', 'Sales tax you collected and paid over', 'expense',
   'II', '23', 'Taxes and licenses', NULL, true, 425)
ON CONFLICT (code) WHERE user_id IS NULL DO UPDATE SET
  name             = EXCLUDED.name,
  flow             = EXCLUDED.flow,
  schedule_c_part  = EXCLUDED.schedule_c_part,
  schedule_c_line  = EXCLUDED.schedule_c_line,
  schedule_c_label = EXCLUDED.schedule_c_label,
  no_line_reason   = EXCLUDED.no_line_reason,
  sort_order       = EXCLUDED.sort_order,
  updated_at       = now();


-- ── Answering the question ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_facilitator_collected(
  p_platform public.listing_platform,
  p_on       date
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT r.is_facilitator
       FROM public.marketplace_facilitator_rules r
      WHERE r.platform = p_platform
        AND r.state IS NULL
        AND r.effective_from <= p_on
        AND (r.effective_to IS NULL OR r.effective_to > p_on)
      ORDER BY r.effective_from DESC
      LIMIT 1),
    -- No rule covers this platform on this date. Fall back to SELLER-COLLECTED,
    -- the conservative answer: it books the tax into income rather than out of
    -- it. Overstating income is a number the seller can dispute; understating
    -- it is one the IRS disputes.
    false
  );
$$;

grant execute on function public.is_facilitator_collected(public.listing_platform, date)
  to authenticated;
grant execute on function public.is_facilitator_collected(public.listing_platform, date)
  to service_role;

-- The platform behind a sale, or NULL when the listing is gone.
--
-- `sales.listing_id` is ON DELETE SET NULL, so a sale can outlive its listing.
-- A NULL platform gets no rule, so it takes the conservative branch above --
-- and US-2992's review queue is where the seller is told which sales those are.
CREATE OR REPLACE FUNCTION public.sale_platform(p_sale_id uuid)
RETURNS public.listing_platform
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT l.platform FROM public.sales s
    JOIN public.listings l ON l.id = s.listing_id
   WHERE s.id = p_sale_id;
$$;

grant execute on function public.sale_platform(uuid) to authenticated;
grant execute on function public.sale_platform(uuid) to service_role;


-- ── The ledger, with the tax branch split ──────────────────────────────────
--
-- Everything below is 00686's function with ONE change: the single unconditional
-- tax entry becomes two mutually exclusive branches. Reproduced in full because
-- CREATE OR REPLACE takes a whole body; the authorization check from US-3002 is
-- carried forward unchanged and is load-bearing.
--
-- NUMBERED 00691, NOT 00689. This file was written as 00689 while 00690
-- (US-3007, inventory write-offs) was landing in parallel, and 00690 reached
-- origin/main first. A migration numbered BELOW an already-pushed one is not
-- merely untidy: apply-prod-migrations.sh skips by MAXIMUM recorded version, so
-- a hole below the maximum is never applied at all -- which is how
-- listings.draft_id from 00134 stayed missing in production for months
-- (US-2726). Renumbered above 00690 before anything was committed.
--
-- 00690 replaces take_inventory_snapshot() and cogs_worksheet(); this replaces
-- rebuild_ledger_for_user(). No overlap, so no rebase was needed on the bodies.

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

comment on table public.marketplace_facilitator_rules is
  'US-2987 which platforms collect and remit sales tax as a marketplace facilitator, with effective dates. A rule, not a constant, because facilitator law arrived state by state and platforms change their handling. No rule for a platform on a date means SELLER-COLLECTED, which overstates income rather than understating it.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00691') on conflict do nothing;
