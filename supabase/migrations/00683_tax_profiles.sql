-- US-2982: the tax profile. One row per seller, holding the settings every
-- later number in the Books and Taxes epic (US-2981) depends on.
--
-- See vault/50-business/books-and-taxes.md for why each field exists and what
-- reads it. The short version: entity type decides which self-employment tax
-- applies, accounting method decides when a sale counts, fiscal year decides
-- what "this year" means (finances.tsx hard-coded January until now), and
-- filing state and status feed the estimated-tax figure.
--
-- TEXT + CHECK RATHER THAN ENUMS, deliberately. An enum value cannot be used in
-- the same transaction that adds it, which makes every future entity type a
-- two-deploy change for no benefit here. These are small closed sets read by
-- application code, not by index-heavy queries.

CREATE TABLE IF NOT EXISTS public.tax_profiles (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL UNIQUE
                           REFERENCES public.users(id) ON DELETE CASCADE,

  entity_type            text NOT NULL DEFAULT 'sole_prop',
  accounting_method      text NOT NULL DEFAULT 'cash',
  fiscal_year_start_month smallint NOT NULL DEFAULT 1,
  filing_state           text,
  filing_status          text NOT NULL DEFAULT 'single',
  business_started_on    date,

  -- Whether the seller HAS an EIN, never the EIN itself. Nothing in this app
  -- needs the number, and storing a nine-digit federal identifier turns this
  -- row into a breach target for no functional gain. The tax packet asks the
  -- seller to write it on the cover sheet themselves.
  has_ein                boolean NOT NULL DEFAULT false,

  -- Feeds the estimated-tax bracket in US-2991. Integer cents, matching the
  -- ledger convention introduced in US-2984 — decimals and floats disagree at
  -- the cent and this epic's whole point is that the numbers agree.
  other_household_income_cents bigint,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.tax_profiles
    ADD CONSTRAINT tax_profiles_entity_type_check CHECK (entity_type IN (
      'sole_prop', 'single_member_llc', 'multi_member_llc',
      'partnership', 's_corp', 'c_corp'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tax_profiles
    ADD CONSTRAINT tax_profiles_accounting_method_check
      CHECK (accounting_method IN ('cash', 'accrual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tax_profiles
    ADD CONSTRAINT tax_profiles_fiscal_month_check
      CHECK (fiscal_year_start_month BETWEEN 1 AND 12);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tax_profiles
    ADD CONSTRAINT tax_profiles_filing_status_check CHECK (filing_status IN (
      'single', 'married_joint', 'married_separate', 'head_of_household',
      'qualifying_surviving_spouse'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Two letters, upper case, or nothing. A free-text state is a state that never
-- joins to a rate table.
DO $$ BEGIN
  ALTER TABLE public.tax_profiles
    ADD CONSTRAINT tax_profiles_filing_state_check
      CHECK (filing_state IS NULL OR filing_state ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tax_profiles
    ADD CONSTRAINT tax_profiles_other_income_check
      CHECK (other_household_income_cents IS NULL
             OR other_household_income_cents >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS set_tax_profiles_updated_at ON public.tax_profiles;
CREATE TRIGGER set_tax_profiles_updated_at
  BEFORE UPDATE ON public.tax_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tax_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can view own tax profile"
  ON public.tax_profiles FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can create own tax profile"
  ON public.tax_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can update own tax profile"
  ON public.tax_profiles FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can delete own tax profile"
  ON public.tax_profiles FOR DELETE USING (auth.uid() = user_id);


-- THE AUDIT TRAIL, and it is not decoration.
--
-- Accounting method and fiscal year are not preferences, they are elections.
-- Switching from cash to accrual mid-stream changes which year a sale falls in,
-- and a seller who flips the toggle in March has silently restated a filed
-- return. Recording the change with its date is what lets a later reader tell a
-- correction from a mistake -- and what US-2995 (period close) reads to explain
-- why a closed year's snapshot does not match a fresh recomputation.
CREATE TABLE IF NOT EXISTS public.tax_profile_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_profile_changes_user
  ON public.tax_profile_changes(user_id, changed_at DESC);

ALTER TABLE public.tax_profile_changes ENABLE ROW LEVEL SECURITY;

-- Read-only to the owner. Inserts come from the trigger below, which runs as
-- the table owner and is not subject to these policies; there is deliberately
-- no INSERT or UPDATE policy, because a history a user can write is not a
-- history.
DROP POLICY IF EXISTS "Users can view own tax profile changes"
  ON public.tax_profile_changes;
CREATE POLICY "Users can view own tax profile changes"
  ON public.tax_profile_changes FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.record_tax_profile_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.accounting_method IS DISTINCT FROM OLD.accounting_method THEN
    INSERT INTO public.tax_profile_changes (user_id, field, old_value, new_value)
    VALUES (NEW.user_id, 'accounting_method',
            OLD.accounting_method, NEW.accounting_method);
  END IF;
  IF NEW.fiscal_year_start_month IS DISTINCT FROM OLD.fiscal_year_start_month THEN
    INSERT INTO public.tax_profile_changes (user_id, field, old_value, new_value)
    VALUES (NEW.user_id, 'fiscal_year_start_month',
            OLD.fiscal_year_start_month::text, NEW.fiscal_year_start_month::text);
  END IF;
  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type THEN
    INSERT INTO public.tax_profile_changes (user_id, field, old_value, new_value)
    VALUES (NEW.user_id, 'entity_type', OLD.entity_type, NEW.entity_type);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_tax_profile_change_trg ON public.tax_profiles;
CREATE TRIGGER record_tax_profile_change_trg
  AFTER UPDATE ON public.tax_profiles
  FOR EACH ROW EXECUTE FUNCTION public.record_tax_profile_change();

comment on table public.tax_profiles is
  'US-2982 one row per seller. The settings the Books and Taxes epic reads: entity, accounting method, fiscal year, filing state and status. Never holds the EIN itself.';
comment on table public.tax_profile_changes is
  'US-2982 append-only history of the three fields that are elections rather than preferences. Written by a trigger; no INSERT policy exists, so a user cannot author their own history.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00683') on conflict do nothing;
