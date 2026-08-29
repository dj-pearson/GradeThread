-- US-2983: the chart of accounts, and the Schedule C line each one feeds.
--
-- expense_category (migration 00019) is eight values chosen for a seller's
-- mental model. None of them names an IRS line, so at tax time somebody re-sorts
-- every row by hand. This is that mapping, written once. It is also the join the
-- QuickBooks push needs (US-2997): a QBO account mapping is a mapping from THIS
-- list to theirs, and without a stable list there is nothing to map.
--
-- The line numbers, the wording of each label and the deliberate refusal to give
-- 'other' a line are all recorded in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.ledger_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL means a system account, shared by every seller and not editable.
  -- A row with a user_id is that seller's own sub-account.
  user_id      uuid REFERENCES public.users(id) ON DELETE CASCADE,

  -- The stable identifier code refers to. Unique among system accounts; a user
  -- sub-account reuses its parent's code with its own name.
  code         text NOT NULL,
  name         text NOT NULL,

  -- Which side of the books. 'excluded' is the one that surprises people: money
  -- that moves through the seller's account and is never theirs, i.e.
  -- marketplace-facilitator sales tax (US-2987).
  flow         text NOT NULL,

  schedule_c_part  text,
  schedule_c_line  text,
  -- The IRS's own wording, so a seller can find the line on the form rather
  -- than trusting our paraphrase of it.
  schedule_c_label text,

  -- Why an account has NO line. Never null on a system account without a line:
  -- an unmapped account with no explanation is indistinguishable from a
  -- forgotten one, and a test asserts this.
  no_line_reason text,

  parent_id    uuid REFERENCES public.ledger_accounts(id) ON DELETE CASCADE,
  is_system    boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  archived     boolean NOT NULL DEFAULT false,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.ledger_accounts
    ADD CONSTRAINT ledger_accounts_flow_check CHECK (flow IN (
      'income', 'cogs', 'expense', 'vehicle', 'excluded', 'asset'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A system account is identified by its code alone, and there is exactly one.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_system_code_idx
  ON public.ledger_accounts (code) WHERE user_id IS NULL;

-- A seller cannot have two sub-accounts with the same name under one parent.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_user_name_idx
  ON public.ledger_accounts (user_id, parent_id, lower(name))
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_user
  ON public.ledger_accounts(user_id) WHERE user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_ledger_accounts_updated_at ON public.ledger_accounts;
CREATE TRIGGER set_ledger_accounts_updated_at
  BEFORE UPDATE ON public.ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ledger_accounts ENABLE ROW LEVEL SECURITY;

-- Everyone reads the system chart; a seller additionally reads their own rows.
DROP POLICY IF EXISTS "Read system and own accounts" ON public.ledger_accounts;
CREATE POLICY "Read system and own accounts"
  ON public.ledger_accounts FOR SELECT
  USING (user_id IS NULL OR auth.uid() = user_id);

-- Writes are confined to the seller's own rows. There is no policy under which
-- user_id IS NULL is writable, so the seeded chart cannot be edited or deleted
-- by anyone holding an anon or authenticated key -- which is the whole point of
-- AC4. A system account is not a suggestion.
DROP POLICY IF EXISTS "Create own sub-accounts" ON public.ledger_accounts;
CREATE POLICY "Create own sub-accounts"
  ON public.ledger_accounts FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Update own sub-accounts" ON public.ledger_accounts;
CREATE POLICY "Update own sub-accounts"
  ON public.ledger_accounts FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Delete own sub-accounts" ON public.ledger_accounts;
CREATE POLICY "Delete own sub-accounts"
  ON public.ledger_accounts FOR DELETE USING (auth.uid() = user_id);


-- ── The seeded chart ───────────────────────────────────────────────────────
--
-- Re-runnable: ON CONFLICT updates the labels so a wording fix ships as an
-- ordinary migration rather than a data script. Nothing here deletes, so a
-- seller's sub-accounts survive every re-seed.

INSERT INTO public.ledger_accounts
  (code, name, flow, schedule_c_part, schedule_c_line, schedule_c_label,
   no_line_reason, is_system, sort_order)
VALUES
  -- Part I: income
  ('sales_revenue', 'Item sales', 'income', 'I', '1',
   'Gross receipts or sales', NULL, true, 100),
  ('shipping_income', 'Shipping the buyer paid', 'income', 'I', '1',
   'Gross receipts or sales', NULL, true, 110),
  ('other_income', 'Other business income', 'income', 'I', '6',
   'Other income', NULL, true, 120),
  ('returns_allowances', 'Refunds and returns', 'income', 'I', '2',
   'Returns and allowances', NULL, true, 130),

  -- Money that passes through and is never the seller's. US-2987 books
  -- facilitator sales tax here so it can be shown as handled rather than
  -- silently dropped -- it is the single biggest reason a 1099-K looks
  -- terrifying, and a number the seller cannot see is a number they distrust.
  ('sales_tax_collected', 'Sales tax the marketplace collected', 'excluded',
   NULL, NULL, NULL,
   'Collected and paid to the state by the marketplace under facilitator law. It was never your income, so it appears on no line of your return -- but it IS inside the gross figure on your 1099-K.',
   true, 140),

  -- Part III: cost of goods sold
  ('inventory_beginning', 'Inventory at the start of the year', 'cogs',
   'III', '35', 'Inventory at beginning of year', NULL, true, 200),
  ('purchases', 'What you paid for the items', 'cogs', 'III', '36',
   'Purchases less cost of items withdrawn for personal use', NULL, true, 210),
  ('cogs_labor', 'Labour that went into the goods', 'cogs', 'III', '37',
   'Cost of labor', NULL, true, 220),
  ('cogs_materials', 'Materials and supplies in the goods', 'cogs', 'III', '38',
   'Materials and supplies', NULL, true, 230),
  ('cogs_other', 'Other costs of the goods', 'cogs', 'III', '39',
   'Other costs', NULL, true, 240),
  ('inventory_ending', 'Inventory at the end of the year', 'cogs', 'III', '41',
   'Inventory at end of year', NULL, true, 250),

  -- Part II: expenses. Only the lines a reseller actually uses.
  ('advertising', 'Advertising and promoted listings', 'expense', 'II', '8',
   'Advertising', NULL, true, 300),
  ('vehicle_mileage', 'Driving for the business', 'vehicle', 'II', '9',
   'Car and truck expenses', NULL, true, 310),
  ('platform_fees', 'Selling fees', 'expense', 'II', '10',
   'Commissions and fees', NULL, true, 320),
  ('depreciation', 'Equipment', 'expense', 'II', '13',
   'Depreciation and section 179 expense deduction', NULL, true, 330),
  ('insurance', 'Business insurance', 'expense', 'II', '15',
   'Insurance (other than health)', NULL, true, 340),
  ('interest_other', 'Business loan or card interest', 'expense', 'II', '16b',
   'Interest -- other', NULL, true, 350),
  ('professional_services', 'Accountant and legal', 'expense', 'II', '17',
   'Legal and professional services', NULL, true, 360),
  ('office_expense', 'Office expense', 'expense', 'II', '18',
   'Office expense', NULL, true, 370),
  ('rent_equipment', 'Equipment rental', 'expense', 'II', '20a',
   'Rent or lease -- vehicles, machinery, and equipment', NULL, true, 380),
  ('rent_property', 'Storage unit or rented space', 'expense', 'II', '20b',
   'Rent or lease -- other business property', NULL, true, 390),
  ('repairs', 'Repairs and maintenance', 'expense', 'II', '21',
   'Repairs and maintenance', NULL, true, 400),
  ('supplies', 'Shipping supplies', 'expense', 'II', '22',
   'Supplies', NULL, true, 410),
  ('taxes_licenses', 'Business taxes and licences', 'expense', 'II', '23',
   'Taxes and licenses', NULL, true, 420),
  ('travel', 'Travel away from home', 'expense', 'II', '24a',
   'Travel', NULL, true, 430),
  ('meals', 'Business meals', 'expense', 'II', '24b',
   'Deductible meals', NULL, true, 440),
  ('utilities', 'Utilities', 'expense', 'II', '25',
   'Utilities', NULL, true, 450),
  ('shipping_postage', 'Postage and labels', 'expense', 'II', '27a',
   'Other expenses', NULL, true, 460),
  ('software_subscriptions', 'Software and subscriptions', 'expense',
   'II', '27a', 'Other expenses', NULL, true, 470),
  ('home_office', 'Home office', 'expense', 'II', '30',
   'Expenses for business use of your home', NULL, true, 480),

  -- The account with no line, and it is not an oversight.
  --
  -- AC3: an uncategorised dollar is exactly what an accountant charges to sort
  -- out, and quietly dropping it on line 27a would hide that. Anything landing
  -- here is a review item (US-2992), not a deduction.
  ('uncategorised', 'Not sorted yet', 'expense', NULL, NULL, NULL,
   'Nothing here reaches your return until you say what it was. We will not guess a deduction on your behalf.',
   true, 900)
ON CONFLICT (code) WHERE user_id IS NULL DO UPDATE SET
  name             = EXCLUDED.name,
  flow             = EXCLUDED.flow,
  schedule_c_part  = EXCLUDED.schedule_c_part,
  schedule_c_line  = EXCLUDED.schedule_c_line,
  schedule_c_label = EXCLUDED.schedule_c_label,
  no_line_reason   = EXCLUDED.no_line_reason,
  sort_order       = EXCLUDED.sort_order,
  updated_at       = now();


-- ── The bridge from the eight existing categories ──────────────────────────
--
-- AC2: no data migration, no loss. The column is nullable and every existing
-- expense keeps working unread; a row with a null account_id resolves through
-- the mapping function below, which is the same answer the seller would have
-- got by hand. Setting the column is how a seller OVERRIDES that default -- for
-- instance moving one 'equipment' purchase off depreciation because it was
-- small enough to expense outright.

ALTER TABLE public.flipdesk_expenses
  ADD COLUMN IF NOT EXISTS account_id uuid
    REFERENCES public.ledger_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_flipdesk_expenses_account
  ON public.flipdesk_expenses(account_id) WHERE account_id IS NOT NULL;

comment on column public.flipdesk_expenses.account_id is
  'US-2983 the seller''s explicit choice of account. NULL means "use the default for this category", resolved by public.default_account_for_category(). Never backfilled: an unset column and a column set to the default mean different things, and only one of them was a decision.';

-- The default mapping, in the database so the ledger (US-2984) and any report
-- resolve it identically to the UI. The judgement calls are the two that a
-- reseller's accountant would query, and they are recorded here rather than
-- left to be re-derived:
--
--   equipment -> line 13 depreciation, NOT line 22 supplies. Whether a camera
--   or a steamer is expensed outright or depreciated is a threshold question
--   only the seller's accountant can settle, and defaulting to supplies would
--   quietly take the aggressive position for them.
--
--   subscriptions -> line 27a other expenses, NOT line 18 office expense. Both
--   are defensible and preparers split roughly evenly. 27a wins because it is
--   labelled and itemised on the form, so the accountant sees what it is.
CREATE OR REPLACE FUNCTION public.default_account_for_category(
  p_category public.expense_category
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_category
    WHEN 'shipping_supplies' THEN 'supplies'
    WHEN 'mileage'           THEN 'vehicle_mileage'
    WHEN 'subscriptions'     THEN 'software_subscriptions'
    WHEN 'platform_fees'     THEN 'platform_fees'
    WHEN 'sourcing_travel'   THEN 'travel'
    WHEN 'equipment'         THEN 'depreciation'
    WHEN 'storage'           THEN 'rent_property'
    WHEN 'other'             THEN 'uncategorised'
  END;
$$;

grant execute on function public.default_account_for_category(public.expense_category)
  to authenticated;
grant execute on function public.default_account_for_category(public.expense_category)
  to service_role;

comment on table public.ledger_accounts is
  'US-2983 the chart of accounts. user_id IS NULL rows are the seeded system chart, readable by everyone and writable by nobody through RLS; rows with a user_id are a seller''s own sub-accounts under a system parent.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00684') on conflict do nothing;
