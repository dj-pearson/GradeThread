-- US-2998: pushing to QuickBooks, and running it twice safely.
--
-- THE HARD REQUIREMENT IS IDEMPOTENCY, and these two tables are how it is met.
-- A sync that runs twice and creates two of everything is worse than no sync:
-- the seller now has to find and delete duplicates inside QuickBooks, by hand,
-- with no way to tell which copy anything downstream already referenced.
--
-- qbo_sync_log is the memory. One row per pushed object, keyed on what it came
-- FROM (kind + source id), holding the QuickBooks id it became. A re-run reads
-- this before it writes anything: a row with a qbo_id and an unchanged payload
-- hash is skipped, a changed one is updated in place, and only a source with no
-- row at all is created. It is also the answer to AC6 -- per-object status with
-- the QuickBooks error text, because "sync failed" with no object named is not
-- an error anybody can act on.
--
-- qbo_sync_runs is the bookmark. A seller connecting with three years of
-- history cannot push it in one request without hitting Intuit's rate limit and
-- losing the run, so a run processes a bounded batch, records where it stopped,
-- and the next call carries on (AC7).
--
-- ONE WAY ONLY, GradeThread to QuickBooks (AC8). Nothing here reads back. Two
-- way sync is a much larger problem and pretending to do it is how books get
-- corrupted.
--
-- The contract is in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.qbo_sync_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections(id) ON DELETE CASCADE,

  -- What it became in QuickBooks. A sale is a SalesReceipt, an operating
  -- expense is a Purchase, a payout is a Deposit.
  object_kind   text NOT NULL
                CHECK (object_kind IN ('sales_receipt', 'purchase', 'deposit')),

  -- What it came FROM: sales.id, flipdesk_expenses.id or ebay_payouts.id --
  -- which is also ledger_entries.source_id for the group. Keying on the source
  -- rather than on a ledger entry id is deliberate: rebuild_ledger_for_user()
  -- deletes and re-inserts every entry, so an entry id is not stable across a
  -- rebuild and a key built on one would create a second copy of everything the
  -- first time the ledger was rebuilt.
  source_id     uuid NOT NULL,

  -- The deterministic DocNumber we send. Also the recovery path: if this table
  -- were ever lost, the same source still computes the same number, and a query
  -- for it in QuickBooks finds the document rather than duplicating it.
  doc_number    text NOT NULL,

  qbo_id         text,
  qbo_sync_token text,

  -- Hash of the payload as it was last accepted. Unchanged means there is
  -- nothing to send, and skipping is what keeps a nightly re-run cheap.
  payload_hash  text,

  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'created', 'updated', 'skipped', 'failed', 'blocked')),

  -- AC6. QuickBooks' own words, not ours. Its validation messages name the
  -- field, and paraphrasing loses the only part that helps.
  error_text    text,

  pushed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The idempotency key. One QuickBooks object per source, for ever.
CREATE UNIQUE INDEX IF NOT EXISTS qbo_sync_log_source_idx
  ON public.qbo_sync_log (user_id, object_kind, source_id);
CREATE INDEX IF NOT EXISTS qbo_sync_log_status_idx
  ON public.qbo_sync_log (user_id, status, updated_at DESC);

comment on table public.qbo_sync_log is
  'US-2998 AC5. One row per pushed object, keyed on its SOURCE rather than on a ledger entry id -- rebuild_ledger_for_user() re-inserts every entry, so an entry-id key would duplicate everything on the first rebuild.';

ALTER TABLE public.qbo_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "qbo_sync_log_select_own" ON public.qbo_sync_log;
CREATE POLICY "qbo_sync_log_select_own" ON public.qbo_sync_log
  FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_sync_log_insert_own" ON public.qbo_sync_log;
CREATE POLICY "qbo_sync_log_insert_own" ON public.qbo_sync_log
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_sync_log_update_own" ON public.qbo_sync_log;
CREATE POLICY "qbo_sync_log_update_own" ON public.qbo_sync_log
  FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_sync_log_delete_own" ON public.qbo_sync_log;
CREATE POLICY "qbo_sync_log_delete_own" ON public.qbo_sync_log
  FOR DELETE USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS set_qbo_sync_log_updated_at ON public.qbo_sync_log;
CREATE TRIGGER set_qbo_sync_log_updated_at
  BEFORE UPDATE ON public.qbo_sync_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ---------------------------------------------------------------------------
-- The run, and its bookmark. AC7.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qbo_sync_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections(id) ON DELETE CASCADE,

  -- Half-open, like every range in this epic: [period_start, period_end).
  period_start  date NOT NULL,
  period_end    date NOT NULL,

  -- Where the last batch stopped. NULL means nothing has been done yet; a date
  -- means "resume from documents on or after this". The date is enough because
  -- the batch is ordered by it and the log makes a repeated document a skip
  -- rather than a duplicate -- so an overlapping resume is safe by
  -- construction, and a bookmark that is slightly behind costs a few skips
  -- rather than a missed sale.
  cursor_date   date,

  status        text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'paused', 'done', 'failed')),

  -- created / updated / skipped / failed / blocked, as they stand.
  counts        jsonb NOT NULL DEFAULT '{}'::jsonb,

  last_error    text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qbo_sync_runs_user_idx
  ON public.qbo_sync_runs (user_id, started_at DESC);

comment on column public.qbo_sync_runs.cursor_date is
  'US-2998 AC7. Resume point. An overlapping resume is safe because qbo_sync_log turns a repeated document into a skip, so a bookmark that is slightly behind costs a few skips rather than a missed sale.';

ALTER TABLE public.qbo_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "qbo_sync_runs_select_own" ON public.qbo_sync_runs;
CREATE POLICY "qbo_sync_runs_select_own" ON public.qbo_sync_runs
  FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_sync_runs_insert_own" ON public.qbo_sync_runs;
CREATE POLICY "qbo_sync_runs_insert_own" ON public.qbo_sync_runs
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_sync_runs_update_own" ON public.qbo_sync_runs;
CREATE POLICY "qbo_sync_runs_update_own" ON public.qbo_sync_runs
  FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_sync_runs_delete_own" ON public.qbo_sync_runs;
CREATE POLICY "qbo_sync_runs_delete_own" ON public.qbo_sync_runs
  FOR DELETE USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS set_qbo_sync_runs_updated_at ON public.qbo_sync_runs;
CREATE TRIGGER set_qbo_sync_runs_updated_at
  BEFORE UPDATE ON public.qbo_sync_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ---------------------------------------------------------------------------
-- What is due to push, in one query.
--
-- The ledger is the source, not the sales table -- so QuickBooks and the P&L
-- cannot disagree about what a sale was worth. Entries are grouped by their
-- SOURCE, which puts a sale's revenue, shipping, fees, label and cost of goods
-- into one document (AC1 and AC4 together), and leaves an expense and a payout
-- as one document each.
--
-- Sales tax is deliberately EXCLUDED from the group total but reported beside
-- it. Under facilitator law the marketplace collected it and paid it to the
-- state, so it was never the seller's money and booking it as income would
-- overstate revenue. The amount is returned so the document can carry it in a
-- note, which is what an accountant reconciling against a 1099-K needs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.qbo_pending_documents(
  p_user_id uuid,
  p_from date,
  p_to date,
  p_after date DEFAULT NULL,
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  object_kind     text,
  source_id       uuid,
  doc_date        date,
  memo            text,
  currency        text,
  total_cents     bigint,
  excluded_tax_cents bigint,
  lines           jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := (select auth.uid());
BEGIN
  -- IT TAKES A USER ID BECAUSE THE CALLER IS THE EDGE, and the edge uses the
  -- service-role client where auth.uid() is NULL. A function keyed on
  -- auth.uid() alone would return nothing there and read as "no sales to push"
  -- rather than as a bug.
  --
  -- The guard is what makes that safe: a signed-in browser caller can only ever
  -- ask for THEMSELVES. Only the service role, which has no auth.uid(), may
  -- name a tenant, and it is already trusted with every row in the table.
  -- No REVOKE (US-2403): the refusal is a 42501 raised here.
  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH grouped AS (
    SELECT
      CASE
        WHEN e.source_kind = 'expense' THEN 'purchase'
        WHEN e.source_kind = 'payout'  THEN 'deposit'
        ELSE 'sales_receipt'
      END AS g_kind,
      e.source_id AS g_source,
      min(e.entry_date) AS g_date,
      min(e.currency)   AS g_currency,
      -- sum(bigint) is numeric in Postgres; the cast is not cosmetic.
      (sum(e.amount_cents) FILTER (WHERE a.code <> 'sales_tax_collected'))::bigint AS g_total,
      coalesce(sum(e.amount_cents) FILTER (WHERE a.code = 'sales_tax_collected'), 0)::bigint
        AS g_tax,
      (array_agg(e.memo ORDER BY e.amount_cents DESC))[1] AS g_memo,
      jsonb_agg(
        jsonb_build_object(
          'account_code', a.code,
          'amount_cents', e.amount_cents,
          'memo', e.memo,
          'detail', e.source_detail
        )
        ORDER BY e.source_detail
      ) FILTER (WHERE a.code <> 'sales_tax_collected') AS g_lines
    FROM public.ledger_entries e
    JOIN public.ledger_accounts a ON a.id = e.account_id
    WHERE e.user_id = p_user_id
      AND e.source_id IS NOT NULL
      AND e.source_kind <> 'adjustment'
      AND e.entry_date >= p_from
      AND e.entry_date <  p_to
    GROUP BY 1, 2
  )
  SELECT g.g_kind, g.g_source, g.g_date, g.g_memo, g.g_currency,
         coalesce(g.g_total, 0)::bigint, g.g_tax::bigint, coalesce(g.g_lines, '[]'::jsonb)
    FROM grouped g
   WHERE (p_after IS NULL OR g.g_date >= p_after)
     AND g.g_lines IS NOT NULL
   ORDER BY g.g_date, g.g_source
   LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
END;
$fn$;

grant execute on function public.qbo_pending_documents(uuid, date, date, date, int) to authenticated;
grant execute on function public.qbo_pending_documents(uuid, date, date, date, int) to service_role;

comment on function public.qbo_pending_documents(uuid, date, date, date, int) is
  'US-2998 AC1/AC4. Groups ledger entries by SOURCE so a sale carries its revenue, shipping, fees, label and cost of goods as one document. Facilitator sales tax is excluded from the total and returned separately: it was never the seller money, so booking it as income would overstate revenue, but an accountant reconciling a 1099-K still needs the number.';


-- ---------------------------------------------------------------------------
-- Which sales a payout paid for. AC3.
--
-- sales.payout_reference carries the marketplace's own payout id, which is what
-- ebay_payouts.payout_id holds. This is a real link, not a guess by amount --
-- matching deposits to sales by total is how a reconciliation goes wrong the
-- first time two payouts are the same size.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.qbo_payout_sales(p_user_id uuid, p_payout_id uuid)
RETURNS TABLE (sale_id uuid, sale_date date, sale_price numeric, title text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := (select auth.uid());
BEGIN
  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT s.id, s.sale_date::date, s.sale_price, coalesce(i.title, 'Sale')
    FROM public.ebay_payouts p
    JOIN public.sales s
      ON s.user_id = p.user_id
     AND s.payout_reference IS NOT NULL
     AND s.payout_reference = p.payout_id
    LEFT JOIN public.inventory_items i ON i.id = s.inventory_item_id
   WHERE p.id = p_payout_id
     AND p.user_id = p_user_id
   ORDER BY s.sale_date, s.id
   LIMIT 500;
END;
$fn$;

grant execute on function public.qbo_payout_sales(uuid, uuid) to authenticated;
grant execute on function public.qbo_payout_sales(uuid, uuid) to service_role;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00705') on conflict do nothing;
