-- US-2988: the 1099-K bridge.
--
-- Every January a reseller gets a form reporting gross payments -- sale price
-- plus shipping plus sales tax, before a single fee -- and their bank shows a
-- fraction of it. The IRS has the same form. Reconciling the two is the
-- highest-anxiety task in reseller bookkeeping and it is entirely mechanical,
-- because GradeThread already holds every subtraction.
--
-- TWO THINGS THIS GETS RIGHT THAT ARE EASY TO GET WRONG:
--
-- 1. A 1099-K IS ALWAYS A CALENDAR YEAR. It has nothing to do with the seller's
--    fiscal year. A seller on a July year start still gets a form covering
--    January to December, and comparing it against their fiscal-year totals
--    produces a variance that is pure artefact. The bridge takes a YEAR, not a
--    date range, and builds the calendar bounds itself.
--
-- 2. GROSS IS THE SAME FIGURE ON BOTH TAX BRANCHES. US-2987 splits sales tax:
--    facilitator tax sits on the excluded account, seller-collected tax sits
--    inside sales_revenue. A 1099-K counts the money the processor moved, so it
--    includes the tax either way -- which means the computed gross has to add
--    the excluded account back in. Getting that wrong makes every marketplace
--    seller's variance equal exactly their sales tax, which looks like a real
--    finding and is not.
--
-- The rules are in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.form_1099k (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Which channel's sales this form covers. The enum, not free text, because
  -- the bridge JOINS on it -- a typed platform is what makes the comparison
  -- possible at all.
  platform    public.listing_platform NOT NULL,
  tax_year    integer NOT NULL,

  gross_cents bigint NOT NULL,

  -- Who issued it. Often NOT the platform: a PayPal-processed eBay year arrives
  -- on a PayPal form. Free text because it is for the seller's records and for
  -- the packet, and nothing joins on it.
  payer_name  text,
  -- LAST FOUR ONLY, and the column name says so. A payer's full TIN is a
  -- federal identifier this app has no use for; four digits is enough for a
  -- seller to match a form to a statement.
  payer_tin_last4 text,

  transaction_count integer,
  received_on date,
  notes       text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- One form per platform per year. A corrected form REPLACES the original,
  -- which is what a seller means when they enter it again.
  UNIQUE (user_id, platform, tax_year)
);

DO $$ BEGIN
  ALTER TABLE public.form_1099k
    ADD CONSTRAINT form_1099k_year_check
      CHECK (tax_year BETWEEN 2000 AND 2200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.form_1099k
    ADD CONSTRAINT form_1099k_gross_check CHECK (gross_cents >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Four digits or nothing. A free-text field here is how a full TIN ends up in
-- the database despite the column name.
DO $$ BEGIN
  ALTER TABLE public.form_1099k
    ADD CONSTRAINT form_1099k_tin_last4_check
      CHECK (payer_tin_last4 IS NULL OR payer_tin_last4 ~ '^[0-9]{4}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_form_1099k_user_year
  ON public.form_1099k(user_id, tax_year DESC);

DROP TRIGGER IF EXISTS set_form_1099k_updated_at ON public.form_1099k;
CREATE TRIGGER set_form_1099k_updated_at
  BEFORE UPDATE ON public.form_1099k
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.form_1099k ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own 1099-K" ON public.form_1099k;
CREATE POLICY "Users can view own 1099-K"
  ON public.form_1099k FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own 1099-K" ON public.form_1099k;
CREATE POLICY "Users can create own 1099-K"
  ON public.form_1099k FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own 1099-K" ON public.form_1099k;
CREATE POLICY "Users can update own 1099-K"
  ON public.form_1099k FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own 1099-K" ON public.form_1099k;
CREATE POLICY "Users can delete own 1099-K"
  ON public.form_1099k FOR DELETE USING ((select auth.uid()) = user_id);

comment on column public.form_1099k.payer_tin_last4 is
  'US-2988 LAST FOUR DIGITS ONLY, enforced by a CHECK. A payer''s full TIN is a federal identifier this app has no use for.';


-- ── The bridge ─────────────────────────────────────────────────────────────
--
-- Reads the ledger (AC4), so a correction anywhere upstream flows through with
-- no re-entry. Scoped to one platform and one CALENDAR year.
--
-- Everything is derived from `ledger_entries` joined back to the sale and its
-- listing. The join is the only way to get a platform: entries carry an account
-- and an amount, not a channel, and adding a platform column to the ledger
-- would denormalise a fact that already lives one hop away.

CREATE OR REPLACE FUNCTION public.form_1099k_bridge(
  p_platform public.listing_platform,
  p_tax_year integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT make_date(p_tax_year, 1, 1) AS from_d,
           make_date(p_tax_year + 1, 1, 1) AS to_d
  ),
  -- Entries on this platform's sales, in this calendar year.
  scoped AS (
    SELECT e.amount_cents, a.code, a.flow
      FROM public.ledger_entries e
      JOIN public.ledger_accounts a ON a.id = e.account_id
      JOIN public.sales s ON s.id = e.source_id
      JOIN public.listings l ON l.id = s.listing_id
      CROSS JOIN bounds b
     WHERE e.source_kind IN ('sale', 'fee', 'shipping', 'cogs')
       AND l.platform = p_platform
       AND e.entry_date >= b.from_d
       AND e.entry_date <  b.to_d
  ),
  parts AS (
    SELECT
      -- WHAT THE PROCESSOR MOVED. Income plus the excluded sales-tax account,
      -- because a 1099-K counts the buyer's payment and the tax was in it.
      -- Adding the excluded account back is what makes this figure identical on
      -- both US-2987 branches; without it every marketplace seller's variance
      -- would equal exactly their sales tax.
      coalesce(sum(amount_cents) FILTER (
        WHERE flow = 'income' AND code <> 'returns_allowances'), 0)
      + coalesce(sum(amount_cents) FILTER (WHERE code = 'sales_tax_collected'), 0)
        AS computed_gross_cents,

      coalesce(sum(amount_cents) FILTER (WHERE code = 'sales_tax_collected'), 0)
        AS facilitator_tax_cents,
      coalesce(sum(amount_cents) FILTER (WHERE code = 'sales_tax_remitted'), 0)
        AS remitted_tax_cents,
      coalesce(sum(amount_cents) FILTER (WHERE code = 'platform_fees'), 0)
        AS fees_cents,
      coalesce(sum(amount_cents) FILTER (WHERE code = 'shipping_postage'), 0)
        AS shipping_cents,
      coalesce(sum(amount_cents) FILTER (WHERE flow = 'cogs'), 0)
        AS cogs_cents,
      coalesce(sum(amount_cents) FILTER (WHERE code = 'returns_allowances'), 0)
        AS returns_cents,
      coalesce(sum(amount_cents) FILTER (
        WHERE code = 'shipping_income'), 0) AS shipping_income_cents
      FROM scoped
  ),
  form AS (
    SELECT gross_cents, payer_name, payer_tin_last4, transaction_count
      FROM public.form_1099k
     WHERE platform = p_platform AND tax_year = p_tax_year
     LIMIT 1
  ),
  counted AS (
    SELECT count(DISTINCT s.id)::integer AS sale_count
      FROM public.sales s
      JOIN public.listings l ON l.id = s.listing_id
      CROSS JOIN bounds b
     WHERE l.platform = p_platform
       AND s.status = 'completed'
       AND s.sale_date::date >= b.from_d
       AND s.sale_date::date <  b.to_d
  )
  SELECT jsonb_build_object(
    'platform', p_platform,
    'tax_year', p_tax_year,
    'from', (SELECT from_d FROM bounds),
    'to',   (SELECT to_d FROM bounds),

    'form_present',        (SELECT count(*) FROM form) > 0,
    'reported_gross_cents',(SELECT gross_cents FROM form),
    'payer_name',          (SELECT payer_name FROM form),
    'payer_tin_last4',     (SELECT payer_tin_last4 FROM form),
    'reported_transaction_count', (SELECT transaction_count FROM form),

    'computed_gross_cents', parts.computed_gross_cents,
    'sale_count',           counted.sale_count,
    'variance_cents',
      coalesce((SELECT gross_cents FROM form), parts.computed_gross_cents)
      - parts.computed_gross_cents,

    -- The subtractions, each already signed the way the ledger stores it: a
    -- cost is negative, so the chain is an addition and nothing has to be
    -- flipped by the reader.
    'facilitator_tax_cents', parts.facilitator_tax_cents,
    'remitted_tax_cents',    parts.remitted_tax_cents,
    'shipping_income_cents', parts.shipping_income_cents,
    'fees_cents',            parts.fees_cents,
    'shipping_cents',        parts.shipping_cents,
    'cogs_cents',            parts.cogs_cents,
    'returns_cents',         parts.returns_cents,

    -- What these sales left, before business-wide overheads. Overheads are NOT
    -- attributable to a platform and are deliberately absent; the P&L is where
    -- they belong, and pretending to split them here would invent a number.
    'profit_before_overheads_cents',
      parts.computed_gross_cents
      - parts.facilitator_tax_cents
      + parts.fees_cents
      + parts.shipping_cents
      + parts.cogs_cents
      + parts.returns_cents
      + parts.remitted_tax_cents
  ) FROM parts, counted;
$$;

grant execute on function public.form_1099k_bridge(public.listing_platform, integer)
  to authenticated;
grant execute on function public.form_1099k_bridge(public.listing_platform, integer)
  to service_role;

-- Which platforms a seller actually sold on in a year, so the screen can offer
-- the right list instead of all twelve.
CREATE OR REPLACE FUNCTION public.platforms_with_sales(p_tax_year integer)
RETURNS TABLE (platform public.listing_platform, sale_count integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT l.platform, count(*)::integer
    FROM public.sales s
    JOIN public.listings l ON l.id = s.listing_id
   WHERE s.status = 'completed'
     AND s.sale_date::date >= make_date(p_tax_year, 1, 1)
     AND s.sale_date::date <  make_date(p_tax_year + 1, 1, 1)
   GROUP BY l.platform
   ORDER BY 2 DESC;
$$;

grant execute on function public.platforms_with_sales(integer) to authenticated;
grant execute on function public.platforms_with_sales(integer) to service_role;

comment on function public.form_1099k_bridge(public.listing_platform, integer) is
  'US-2988 the bridge from a 1099-K gross to profit, for ONE platform and ONE CALENDAR year (a 1099-K never follows a fiscal year). computed_gross adds the excluded sales-tax account back in, because a 1099-K counts the buyer''s payment - which is what makes the figure identical on both US-2987 tax branches.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00693') on conflict do nothing;
