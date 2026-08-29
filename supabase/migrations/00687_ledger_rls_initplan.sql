-- 00687_ledger_rls_initplan.sql
--
-- US-3005: rewrite the Books-and-Taxes RLS policies into the initplan form.
--
-- 00683, 00684 and 00685 wrote thirteen policies as `auth.uid() = user_id`.
-- US-1927 established the rule and rls-guard_test.ts enforces it: inside an RLS
-- policy, a bare `auth.uid()` is a VOLATILE call the planner re-evaluates PER
-- ROW, while `(select auth.uid())` is an InitPlan evaluated ONCE per statement.
-- On a small table the difference is invisible; ledger_entries is the opposite
-- of a small table, because the derivation writes NINE rows per completed sale.
--
-- Those three migrations are already applied in production, so this is a new
-- migration rather than an edit. Every statement is DROP-then-CREATE, which is
-- the only way to change a policy's expression, and every DROP is IF EXISTS so
-- the file is safe to run twice.
--
-- ⚠ THE PREDICATES ARE OTHERWISE UNCHANGED, deliberately. This is a planner
-- fix, not a permissions change: the same rows are visible to the same people
-- before and after. `Read system and own accounts` keeps its `user_id IS NULL
-- OR` arm, which is what makes the system chart of accounts readable by
-- everyone, and the three ledger_entries write policies keep their
-- `source_kind = 'adjustment'` arm, which is what stops a seller hand-writing a
-- 'sale' row and inflating a number their own 1099-K reconciliation checks.

-- ── 00683: tax_profiles ────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can view own tax profile"
  ON public.tax_profiles FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can create own tax profile"
  ON public.tax_profiles FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can update own tax profile"
  ON public.tax_profiles FOR UPDATE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own tax profile" ON public.tax_profiles;
CREATE POLICY "Users can delete own tax profile"
  ON public.tax_profiles FOR DELETE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own tax profile changes"
  ON public.tax_profile_changes;
CREATE POLICY "Users can view own tax profile changes"
  ON public.tax_profile_changes FOR SELECT USING ((select auth.uid()) = user_id);

-- ── 00684: ledger_accounts ─────────────────────────────────────────────────

DROP POLICY IF EXISTS "Read system and own accounts" ON public.ledger_accounts;
CREATE POLICY "Read system and own accounts"
  ON public.ledger_accounts FOR SELECT
  USING (user_id IS NULL OR (select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Create own sub-accounts" ON public.ledger_accounts;
CREATE POLICY "Create own sub-accounts"
  ON public.ledger_accounts FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Update own sub-accounts" ON public.ledger_accounts;
CREATE POLICY "Update own sub-accounts"
  ON public.ledger_accounts FOR UPDATE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Delete own sub-accounts" ON public.ledger_accounts;
CREATE POLICY "Delete own sub-accounts"
  ON public.ledger_accounts FOR DELETE USING ((select auth.uid()) = user_id);

-- ── 00685: ledger_entries ──────────────────────────────────────────────────
--
-- The table this rule exists for. Nine rows per completed sale, and a seller
-- with a year of history reads them all on one screen.

DROP POLICY IF EXISTS "Users can view own ledger" ON public.ledger_entries;
CREATE POLICY "Users can view own ledger"
  ON public.ledger_entries FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create own adjustments" ON public.ledger_entries;
CREATE POLICY "Users can create own adjustments"
  ON public.ledger_entries FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id AND source_kind = 'adjustment');

DROP POLICY IF EXISTS "Users can update own adjustments" ON public.ledger_entries;
CREATE POLICY "Users can update own adjustments"
  ON public.ledger_entries FOR UPDATE
  USING ((select auth.uid()) = user_id AND source_kind = 'adjustment');

DROP POLICY IF EXISTS "Users can delete own adjustments" ON public.ledger_entries;
CREATE POLICY "Users can delete own adjustments"
  ON public.ledger_entries FOR DELETE
  USING ((select auth.uid()) = user_id AND source_kind = 'adjustment');

insert into public.applied_migrations (version) values ('00687') on conflict do nothing;
