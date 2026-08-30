-- US-2995: close a period, and the numbers stop moving.
--
-- Once a return is filed, that year's figures are a matter of record. Today,
-- editing an item's acquired_price silently rewrites a P&L for a year already
-- reported, and nothing anywhere says it happened -- which is how a seller ends
-- up unable to reproduce the numbers they filed.
--
-- AC2 IS THE WHOLE DIFFICULTY, AND IT IS WHY THIS IS TRIGGERS RATHER THAN
-- POLICIES. The edge service uses the service-role client, which BYPASSES RLS.
-- A policy-based lock would hold against the browser and let every edge route,
-- job and webhook straight through -- and those are exactly the paths that
-- rewrite history without anybody watching. A BEFORE trigger fires for the
-- service role too.
--
-- WHAT IS DELIBERATELY NOT LOCKED, because a lock that blocks ordinary work
-- gets turned off: nothing about SHIPPING, tracking, listing state or photos.
-- Closing a year must not stop a seller posting a parcel for a sale that
-- happened in it. Only the columns that change the NUMBERS are frozen.
--
-- The rules are in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.closed_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Half-open, like every range in this epic: [period_start, period_end).
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  label         text NOT NULL,

  -- AC1. The figures AS THEY STOOD at the moment of close, so a later
  -- recomputation can be compared against what was actually filed rather than
  -- silently replacing it.
  closing_figures jsonb NOT NULL DEFAULT '{}'::jsonb,

  closed_at     timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid,

  -- NULL while closed. Set on reopen, which keeps the row rather than deleting
  -- it: a period that was closed and reopened is a different fact from one that
  -- was never closed, and the difference is exactly what an accountant asks
  -- about.
  reopened_at   timestamptz,
  reopened_by   uuid,
  reopen_reason text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.closed_periods
    ADD CONSTRAINT closed_periods_range_check CHECK (period_end > period_start);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.closed_periods
    ADD CONSTRAINT closed_periods_reopen_check
      CHECK (reopened_at IS NULL OR btrim(coalesce(reopen_reason, '')) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One OPEN close per period. A reopened row does not block closing again, which
-- is what makes correct-and-reclose work.
CREATE UNIQUE INDEX IF NOT EXISTS closed_periods_active_idx
  ON public.closed_periods (user_id, period_start, period_end)
  WHERE reopened_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_closed_periods_user_active
  ON public.closed_periods (user_id, period_start, period_end)
  WHERE reopened_at IS NULL;

DROP TRIGGER IF EXISTS set_closed_periods_updated_at ON public.closed_periods;
CREATE TRIGGER set_closed_periods_updated_at
  BEFORE UPDATE ON public.closed_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.closed_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own closed periods" ON public.closed_periods;
CREATE POLICY "Users can view own closed periods"
  ON public.closed_periods FOR SELECT USING ((select auth.uid()) = user_id);
-- No INSERT, UPDATE or DELETE policy. Closing and reopening go through the
-- functions below, which snapshot the figures and record who did it. A close a
-- user could hand-write is not a close, and a DELETE would erase the audit
-- trail that is the entire point of AC4.

comment on table public.closed_periods is
  'US-2995 a filed period. Reopening SETS reopened_at rather than deleting the row: a period that was closed and reopened is a different fact from one never closed, and that difference is what an accountant asks about.';


-- ── Is this date locked? ───────────────────────────────────────────────────
--
-- STABLE and tiny, because it runs on every write to four tables. The partial
-- index above is what keeps it cheap.
CREATE OR REPLACE FUNCTION public.is_period_closed(p_user_id uuid, p_on date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.closed_periods
     WHERE user_id = p_user_id
       AND reopened_at IS NULL
       AND p_on >= period_start
       AND p_on <  period_end
  );
$fn$;

grant execute on function public.is_period_closed(uuid, date) to authenticated;
grant execute on function public.is_period_closed(uuid, date) to service_role;


-- ── The lock ───────────────────────────────────────────────────────────────
--
-- One trigger function, reused. Each table tells it which column carries the
-- date, via TG_ARGV, so there is one implementation of the rule rather than
-- four that drift.
--
-- The message names the escape hatch (AC3), because a refusal a seller cannot
-- act on is just a wall: an adjusting entry into the OPEN period, not an edit
-- to history.
CREATE OR REPLACE FUNCTION public.refuse_write_to_closed_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_date_col text := TG_ARGV[0];
  v_owner_col text := coalesce(TG_ARGV[1], 'user_id');
  v_old_date date;
  v_new_date date;
  v_owner uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    EXECUTE format('SELECT ($1).%I::date, ($1).%I::uuid', v_date_col, v_owner_col)
      INTO v_old_date, v_owner USING OLD;
    IF v_owner IS NOT NULL AND public.is_period_closed(v_owner, v_old_date) THEN
      RAISE EXCEPTION
        'That date is in a closed period (%). Add an adjusting entry in the open period instead, or reopen the period with a reason.',
        v_old_date
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    EXECUTE format('SELECT ($1).%I::date, ($1).%I::uuid', v_date_col, v_owner_col)
      INTO v_new_date, v_owner USING NEW;
    IF v_owner IS NOT NULL AND public.is_period_closed(v_owner, v_new_date) THEN
      RAISE EXCEPTION
        'That date is in a closed period (%). Add an adjusting entry in the open period instead, or reopen the period with a reason.',
        v_new_date
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$fn$;

-- The four tables whose rows ARE the numbers. Nothing about shipping, tracking,
-- listing state or photos is locked: closing a year must not stop a seller
-- posting a parcel for a sale that happened in it.
DROP TRIGGER IF EXISTS lock_closed_expenses ON public.flipdesk_expenses;
CREATE TRIGGER lock_closed_expenses
  BEFORE INSERT OR UPDATE OR DELETE ON public.flipdesk_expenses
  FOR EACH ROW EXECUTE FUNCTION public.refuse_write_to_closed_period('spent_on');

DROP TRIGGER IF EXISTS lock_closed_trips ON public.mileage_trips;
CREATE TRIGGER lock_closed_trips
  BEFORE INSERT OR UPDATE OR DELETE ON public.mileage_trips
  FOR EACH ROW EXECUTE FUNCTION public.refuse_write_to_closed_period('trip_date');

-- SALES ARE LOCKED ON THE MONEY COLUMNS ONLY, which is why this one is its own
-- function rather than the shared trigger. A sale in a closed year must still
-- be able to gain a tracking number, a delivery date or a status change -- a
-- buyer can open a return in February on a December sale, and refusing that
-- write would break the marketplace sync rather than protect the books.
CREATE OR REPLACE FUNCTION public.refuse_money_edit_in_closed_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.is_period_closed(
       coalesce(NEW.user_id, OLD.user_id), coalesce(OLD.sale_date, NEW.sale_date)::date)
  THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'That sale is in a closed period. Add an adjusting entry in the open period instead, or reopen the period with a reason.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'UPDATE' AND (
       NEW.sale_price IS DISTINCT FROM OLD.sale_price
    OR NEW.platform_fees IS DISTINCT FROM OLD.platform_fees
    OR NEW.payment_processing_fees IS DISTINCT FROM OLD.payment_processing_fees
    OR NEW.shipping_collected IS DISTINCT FROM OLD.shipping_collected
    OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost
    OR NEW.grading_cost IS DISTINCT FROM OLD.grading_cost
    OR NEW.other_costs IS DISTINCT FROM OLD.other_costs
    OR NEW.tax IS DISTINCT FROM OLD.tax
    OR NEW.sale_date IS DISTINCT FROM OLD.sale_date
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION
      'That sale is in a closed period and its money cannot change. Add an adjusting entry in the open period instead, or reopen the period with a reason.'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS lock_closed_sales ON public.sales;
CREATE TRIGGER lock_closed_sales
  BEFORE INSERT OR UPDATE OR DELETE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.refuse_money_edit_in_closed_period();

-- An item's COST is what reaches a closed year's COGS, and editing it after the
-- fact is the exact defect this story exists to stop. Everything else about an
-- item -- title, photos, status, measurements -- stays editable for ever,
-- because none of it moves a number that was filed.
CREATE OR REPLACE FUNCTION public.refuse_cost_edit_in_closed_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.acquired_price IS DISTINCT FROM OLD.acquired_price
  THEN
    -- Locked if the item was SOLD inside a closed period, because that is when
    -- its cost hit the books. An unsold item's cost has reached no return yet.
    IF EXISTS (
      SELECT 1 FROM public.sales s
       WHERE s.inventory_item_id = OLD.id
         AND s.status = 'completed'
         AND public.is_period_closed(OLD.user_id, s.sale_date::date)
    ) THEN
      RAISE EXCEPTION
        'That item sold in a closed period, so what it cost is part of a filed return. Reopen the period with a reason if it was genuinely wrong.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS lock_closed_item_cost ON public.inventory_items;
CREATE TRIGGER lock_closed_item_cost
  BEFORE UPDATE OF acquired_price ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.refuse_cost_edit_in_closed_period();


-- ── Closing and reopening ──────────────────────────────────────────────────
--
-- AC5: closing a year and valuing its inventory are ONE action. A close that
-- left the seller to remember a second step would produce closed years with no
-- Part III figures, which is the state US-2986 exists to prevent.
-- SECURITY DEFINER, and that is not incidental. `closed_periods` deliberately
-- has NO insert or update policy: a close a user could hand-write is not a
-- close, and a delete would erase the audit trail AC4 exists for. So the write
-- has to come from a definer function -- which then owes an authorization check
-- in its own body, below.
--
-- NO REVOKE anywhere. On this Postgres image a denied EXECUTE from anon or
-- authenticated restarts the whole database (US-2403), so authorization lives
-- in the body and raises an ordinary 42501. Same shape as 00686.
CREATE OR REPLACE FUNCTION public.close_period(
  p_period_start date,
  p_period_end   date,
  p_label        text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_figures jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.closed_periods
     WHERE user_id = v_uid AND reopened_at IS NULL
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RAISE EXCEPTION 'That period is already closed.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The inventory valuation FIRST, while writes are still allowed. Closing
  -- before snapshotting would lock the very table the snapshot reads from and
  -- leave the period closed with no Part III figures.
  PERFORM public.take_inventory_snapshot(
    v_uid, p_period_end, p_label, false);

  -- AC1: the figures as they stood, so a later recomputation can be COMPARED
  -- against what was filed rather than silently replacing it.
  SELECT jsonb_build_object(
    'ledger', public.ledger_reconciliation(p_period_start::timestamptz),
    'cogs', public.cogs_worksheet(p_period_start, p_period_end),
    'snapshot_total_cents', (
      SELECT total_cost_cents FROM public.inventory_snapshots
       WHERE user_id = v_uid AND as_of = p_period_end
    ),
    'closed_on', now()
  ) INTO v_figures;

  INSERT INTO public.closed_periods
    (user_id, period_start, period_end, label, closing_figures, closed_by)
  VALUES (v_uid, p_period_start, p_period_end, p_label, v_figures, v_uid)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

grant execute on function public.close_period(date, date, text) to authenticated;
grant execute on function public.close_period(date, date, text) to service_role;

-- AC4. A reason is required by the CHECK constraint, and the row is kept rather
-- than deleted so the trail survives.
-- SECURITY DEFINER for the same reason as close_period, with the same in-body
-- check: the UPDATE has to get past a table with no update policy, and the
-- `user_id = v_uid` filter below is what keeps one seller out of another's
-- audit trail.
CREATE OR REPLACE FUNCTION public.reopen_period(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := (select auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Reopening needs a reason.' USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE public.closed_periods
     SET reopened_at = now(), reopened_by = v_uid, reopen_reason = btrim(p_reason)
   WHERE id = p_id AND user_id = v_uid AND reopened_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No open close with that id.' USING ERRCODE = 'raise_exception';
  END IF;
END;
$fn$;

grant execute on function public.reopen_period(uuid, text) to authenticated;
grant execute on function public.reopen_period(uuid, text) to service_role;

comment on function public.refuse_write_to_closed_period() is
  'US-2995 AC2. A BEFORE trigger rather than an RLS policy, because the edge uses the service-role client which BYPASSES RLS -- and those are exactly the paths (routes, jobs, webhooks) that would rewrite history unwatched. The message names the escape hatch, because a refusal a seller cannot act on is just a wall.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00702') on conflict do nothing;
