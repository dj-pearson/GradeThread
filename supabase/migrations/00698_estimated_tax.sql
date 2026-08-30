-- US-2991: quarterly estimated tax. What to set aside, and when it is due.
--
-- The single most useful thing this app can tell a reseller is a dollar figure
-- to move into a second account today. Most of them find out they owed it in
-- April, and the part that surprises people is that self-employment tax is
-- 15.3% before a cent of income tax.
--
-- WHAT THIS COMPUTES EXACTLY, AND WHAT IT REFUSES TO GUESS. That split is the
-- whole design, because an estimated-tax screen that quietly invents half its
-- inputs is worse than no screen:
--
--   SELF-EMPLOYMENT TAX is mechanical and is computed exactly. 15.3% on 92.35%
--   of net earnings, with the Social Security half capped at the year's wage
--   base and Medicare uncapped. All three numbers are dated data below.
--
--   INCOME TAX IS NOT COMPUTED FROM BRACKETS, deliberately. It depends on the
--   seller's whole return -- a spouse's wages, a W-2 job, other deductions,
--   credits, state tax -- none of which this app sees. Shipping a bracket
--   table would produce a confident number built on inputs we do not have.
--   The seller picks a rate and the screen says it is their assumption.
--
--   THE SAFE HARBOUR needs no projection at all: pay 100% of last year's tax
--   (110% above an income threshold) and the underpayment penalty does not
--   apply however the year turns out. It is the more reliable target and the
--   screen offers it beside the estimate.
--
-- Estimated tax payments are PERSONAL, not a business expense. They never reach
-- the ledger or the P&L. A seller who deducted them would understate their own
-- profit and overstate the deduction, which is why the payments table below is
-- deliberately not wired into rebuild_ledger_for_user().
--
-- The rules are in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.tax_rate_years (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year      integer NOT NULL UNIQUE,

  -- Social Security stops at the wage base; Medicare does not. Both halves are
  -- here in basis points so the arithmetic is integer all the way down.
  ss_wage_base_cents      bigint NOT NULL,
  social_security_rate_bps integer NOT NULL,
  medicare_rate_bps        integer NOT NULL,
  -- Net earnings from self-employment are 92.35% of net profit. Not a rounding
  -- fudge: it is the deduction for the employer half, and leaving it out
  -- overstates the tax by about 8%.
  se_income_factor_bps     integer NOT NULL,

  -- The additional Medicare surcharge, and the income at which it starts.
  addl_medicare_rate_bps   integer NOT NULL,
  addl_medicare_threshold  jsonb NOT NULL,

  -- Safe harbour: 100% of last year's tax, or 110% above this AGI.
  safe_harbour_high_agi_cents bigint NOT NULL,
  safe_harbour_low_bps        integer NOT NULL,
  safe_harbour_high_bps       integer NOT NULL,

  is_provisional boolean NOT NULL DEFAULT false,
  note          text NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_rate_years ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone may read tax rate years" ON public.tax_rate_years;
CREATE POLICY "Anyone may read tax rate years"
  ON public.tax_rate_years FOR SELECT USING (true);

INSERT INTO public.tax_rate_years
  (tax_year, ss_wage_base_cents, social_security_rate_bps, medicare_rate_bps,
   se_income_factor_bps, addl_medicare_rate_bps, addl_medicare_threshold,
   safe_harbour_high_agi_cents, safe_harbour_low_bps, safe_harbour_high_bps,
   is_provisional, note)
VALUES
  (2024, 16860000, 1240, 290, 9235, 90,
   '{"single": 20000000, "married_joint": 25000000, "married_separate": 12500000, "head_of_household": 20000000, "qualifying_surviving_spouse": 20000000}'::jsonb,
   15000000, 10000, 11000, false,
   'Social Security wage base $168,600 for 2024. SE tax is 15.3% (12.4% + 2.9%) on 92.35% of net profit. Additional Medicare 0.9% above the threshold. Safe harbour 100% of last year, 110% above $150,000 AGI. Check the IRS figures before filing.'),
  (2025, 17610000, 1240, 290, 9235, 90,
   '{"single": 20000000, "married_joint": 25000000, "married_separate": 12500000, "head_of_household": 20000000, "qualifying_surviving_spouse": 20000000}'::jsonb,
   15000000, 10000, 11000, false,
   'Social Security wage base $176,100 for 2025. Everything else as 2024. Check the IRS figures before filing.'),
  (2026, 17610000, 1240, 290, 9235, 90,
   '{"single": 20000000, "married_joint": 25000000, "married_separate": 12500000, "head_of_household": 20000000, "qualifying_surviving_spouse": 20000000}'::jsonb,
   15000000, 10000, 11000, true,
   'PROVISIONAL: the wage base is carried forward from 2025 because the 2026 figure was not published when this shipped. It rises most years, so this UNDERSTATES the Social Security portion for a high earner. Update this row when the Social Security Administration announces it.')
ON CONFLICT (tax_year) DO UPDATE SET
  ss_wage_base_cents          = EXCLUDED.ss_wage_base_cents,
  social_security_rate_bps    = EXCLUDED.social_security_rate_bps,
  medicare_rate_bps           = EXCLUDED.medicare_rate_bps,
  se_income_factor_bps        = EXCLUDED.se_income_factor_bps,
  addl_medicare_rate_bps      = EXCLUDED.addl_medicare_rate_bps,
  addl_medicare_threshold     = EXCLUDED.addl_medicare_threshold,
  safe_harbour_high_agi_cents = EXCLUDED.safe_harbour_high_agi_cents,
  safe_harbour_low_bps        = EXCLUDED.safe_harbour_low_bps,
  safe_harbour_high_bps       = EXCLUDED.safe_harbour_high_bps,
  is_provisional              = EXCLUDED.is_provisional,
  note                        = EXCLUDED.note,
  updated_at                  = now();


-- What the seller has actually paid, and what they are planning on.
--
-- AC3: without this the screen restates the ideal for ever. With it, it shows
-- the shortfall, which is the only figure that changes what someone does today.
CREATE TABLE IF NOT EXISTS public.estimated_tax_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tax_year    integer NOT NULL,
  -- 1 to 4. The four periods are NOT even quarters -- Q2 covers two months and
  -- Q4 covers four -- which is exactly why they are numbered rather than
  -- derived from a date.
  quarter     integer NOT NULL,
  paid_cents  bigint NOT NULL,
  paid_on     date,
  note        text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tax_year, quarter)
);

DO $$ BEGIN
  ALTER TABLE public.estimated_tax_payments
    ADD CONSTRAINT estimated_tax_quarter_check CHECK (quarter BETWEEN 1 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.estimated_tax_payments
    ADD CONSTRAINT estimated_tax_amount_check CHECK (paid_cents >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_estimated_tax_payments_user_year
  ON public.estimated_tax_payments(user_id, tax_year);

DROP TRIGGER IF EXISTS set_estimated_tax_payments_updated_at
  ON public.estimated_tax_payments;
CREATE TRIGGER set_estimated_tax_payments_updated_at
  BEFORE UPDATE ON public.estimated_tax_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.estimated_tax_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own estimated payments"
  ON public.estimated_tax_payments;
CREATE POLICY "Users can view own estimated payments"
  ON public.estimated_tax_payments FOR SELECT
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own estimated payments"
  ON public.estimated_tax_payments;
CREATE POLICY "Users can create own estimated payments"
  ON public.estimated_tax_payments FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own estimated payments"
  ON public.estimated_tax_payments;
CREATE POLICY "Users can update own estimated payments"
  ON public.estimated_tax_payments FOR UPDATE
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own estimated payments"
  ON public.estimated_tax_payments;
CREATE POLICY "Users can delete own estimated payments"
  ON public.estimated_tax_payments FOR DELETE
  USING ((select auth.uid()) = user_id);


-- The seller's own assumptions, which the screen has to name back to them.
ALTER TABLE public.tax_profiles
  ADD COLUMN IF NOT EXISTS income_tax_rate_bps integer;
ALTER TABLE public.tax_profiles
  ADD COLUMN IF NOT EXISTS last_year_total_tax_cents bigint;

comment on column public.tax_profiles.income_tax_rate_bps is
  'US-2991 the income-tax rate the SELLER chose, in basis points. NULL means they have not chosen and the screen uses a stated default. Deliberately not derived from brackets: income tax depends on a whole return this app does not see, and a confident number built on inputs we do not have is worse than an assumption the seller owns.';
comment on column public.tax_profiles.last_year_total_tax_cents is
  'US-2991 total tax from last year''s return, for the safe harbour. Pay 100% of it (110% above the AGI threshold) and the underpayment penalty does not apply however this year turns out - which needs no projection at all.';

comment on table public.estimated_tax_payments is
  'US-2991 what the seller actually paid, per quarter. NEVER reaches the ledger: estimated tax is personal, not a business expense, and deducting it would understate their own profit.';
comment on table public.tax_rate_years is
  'US-2991 dated self-employment tax data. Reference data with no user_id: readable by everyone, writable by nobody. The 2026 row is PROVISIONAL - the wage base is carried forward and therefore understates Social Security for a high earner.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00698') on conflict do nothing;
