-- US-2994: bank and card CSV import, matched against what the books already
-- know.
--
-- The gap a reseller notices between GradeThread and QuickBooks is the bank
-- feed. A live feed means Plaid, which is a paid dependency and a decision that
-- is not this story's to make. A CSV import is most of the value: every bank and
-- card exports one, and matching those rows against existing expenses catches
-- BOTH the expense that was logged twice and the one that was never logged.
--
-- THE STATEMENT ROW IS ITS OWN RECORD AND NEVER MUTATES AN EXPENSE (AC5). A
-- match is a LINK, recorded and reversible. The alternative -- letting an import
-- rewrite an amount a seller typed -- is how a bookkeeping tool silently
-- disagrees with the person using it, and the person always loses because they
-- do not know it happened.
--
-- The rules are in vault/50-business/books-and-taxes.md.

-- One per bank or card the seller imports from. Holds the COLUMN MAPPING, so it
-- is chosen once and remembered (AC1) -- every bank's CSV is differently shaped
-- and re-mapping on every import is the friction that stops anyone doing it.
CREATE TABLE IF NOT EXISTS public.statement_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  name          text NOT NULL,
  -- {"date":"Transaction Date","amount":"Amount","description":"Description",
  --  "sign":"negative_is_spend"}
  column_map    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

DO $$ BEGIN
  ALTER TABLE public.statement_sources
    ADD CONSTRAINT statement_sources_name_check CHECK (btrim(name) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS set_statement_sources_updated_at
  ON public.statement_sources;
CREATE TRIGGER set_statement_sources_updated_at
  BEFORE UPDATE ON public.statement_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.statement_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own statement sources"
  ON public.statement_sources;
CREATE POLICY "Users can view own statement sources"
  ON public.statement_sources FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own statement sources"
  ON public.statement_sources;
CREATE POLICY "Users can create own statement sources"
  ON public.statement_sources FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own statement sources"
  ON public.statement_sources;
CREATE POLICY "Users can update own statement sources"
  ON public.statement_sources FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own statement sources"
  ON public.statement_sources;
CREATE POLICY "Users can delete own statement sources"
  ON public.statement_sources FOR DELETE USING ((select auth.uid()) = user_id);


CREATE TABLE IF NOT EXISTS public.statement_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_id     uuid NOT NULL
                  REFERENCES public.statement_sources(id) ON DELETE CASCADE,

  posted_on     date NOT NULL,
  -- Signed integer cents, as it appeared on the statement: negative is money
  -- leaving. Kept signed rather than normalised to a magnitude, because a
  -- refund on a card statement is a real positive row and flattening it would
  -- make a return look like a purchase.
  amount_cents  bigint NOT NULL,
  description   text NOT NULL DEFAULT '',

  -- THE IDEMPOTENCY KEY, and AC3 turns on it being derived from the ROW rather
  -- than from the import run. A seller re-exporting an overlapping date range
  -- is the normal case, not an error: they widen the range to catch something
  -- they missed. Keying off the run would duplicate every overlapping row and
  -- keying off a line number would break the moment the bank reorders.
  row_fingerprint text NOT NULL,

  -- Set when this row is accounted for. `matched_expense_id` is a LINK: it
  -- never changes the expense, and clearing it puts the row back in the queue.
  matched_expense_id uuid
                  REFERENCES public.flipdesk_expenses(id) ON DELETE SET NULL,
  -- 'unreviewed' | 'matched' | 'ignored'
  status        text NOT NULL DEFAULT 'unreviewed',
  ignored_reason text,

  imported_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, source_id, row_fingerprint)
);

DO $$ BEGIN
  ALTER TABLE public.statement_rows
    ADD CONSTRAINT statement_rows_status_check
      CHECK (status IN ('unreviewed', 'matched', 'ignored'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A matched row must name what it matched, and an unmatched one must not.
-- Without this the two columns drift and "matched" stops meaning anything.
DO $$ BEGIN
  ALTER TABLE public.statement_rows
    ADD CONSTRAINT statement_rows_match_check
      CHECK (
        (status = 'matched' AND matched_expense_id IS NOT NULL)
        OR (status <> 'matched' AND matched_expense_id IS NULL)
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_statement_rows_user_status
  ON public.statement_rows(user_id, status, posted_on DESC);
CREATE INDEX IF NOT EXISTS idx_statement_rows_expense
  ON public.statement_rows(matched_expense_id)
  WHERE matched_expense_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_statement_rows_updated_at ON public.statement_rows;
CREATE TRIGGER set_statement_rows_updated_at
  BEFORE UPDATE ON public.statement_rows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.statement_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own statement rows" ON public.statement_rows;
CREATE POLICY "Users can view own statement rows"
  ON public.statement_rows FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own statement rows" ON public.statement_rows;
CREATE POLICY "Users can create own statement rows"
  ON public.statement_rows FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can update own statement rows" ON public.statement_rows;
CREATE POLICY "Users can update own statement rows"
  ON public.statement_rows FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own statement rows" ON public.statement_rows;
CREATE POLICY "Users can delete own statement rows"
  ON public.statement_rows FOR DELETE USING ((select auth.uid()) = user_id);


-- ── Matching ───────────────────────────────────────────────────────────────
--
-- Candidates for one statement row, best first. It SUGGESTS; the seller
-- confirms. Auto-matching on a score would be wrong here in a way that is hard
-- to undo: two $24.99 supply orders three days apart are indistinguishable to
-- any rule, and the person who bought them knows instantly.
--
-- An expense already linked to another statement row is excluded, so one
-- expense cannot satisfy two statement lines -- which is exactly the shape of
-- the double-payment a bank import is supposed to catch.
CREATE OR REPLACE FUNCTION public.match_statement_row(p_row_id uuid)
RETURNS TABLE (
  expense_id uuid,
  description text,
  amount numeric,
  spent_on date,
  day_gap integer,
  score integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH row AS (
    SELECT * FROM public.statement_rows WHERE id = p_row_id
  )
  SELECT
    x.id, x.description, x.amount, x.spent_on,
    abs(x.spent_on - r.posted_on)::integer AS day_gap,
    (
      -- The amount has to match to the cent or it is not the same transaction.
      -- Everything else is tie-breaking.
      100
      -- A statement posts a day or two after the purchase, so closeness is a
      -- real signal and exactness is not required.
      - least(abs(x.spent_on - r.posted_on), 10) * 5
      -- A shared word between the descriptions, when both have one.
      + CASE
          WHEN x.description IS NOT NULL
           AND btrim(x.description) <> ''
           AND r.description <> ''
           AND lower(r.description) LIKE '%' || lower(split_part(btrim(x.description), ' ', 1)) || '%'
          THEN 20 ELSE 0
        END
    )::integer AS score
  FROM row r
  JOIN public.flipdesk_expenses x
    ON (x.amount * 100)::bigint = abs(r.amount_cents)
   AND x.spent_on BETWEEN r.posted_on - 10 AND r.posted_on + 10
  WHERE NOT EXISTS (
    SELECT 1 FROM public.statement_rows other
     WHERE other.matched_expense_id = x.id AND other.id <> r.id
  )
  ORDER BY score DESC, day_gap ASC
  LIMIT 5;
$fn$;

grant execute on function public.match_statement_row(uuid) to authenticated;
grant execute on function public.match_statement_row(uuid) to service_role;

-- The three counts AC4 asks for, plus the money behind them.
CREATE OR REPLACE FUNCTION public.statement_import_summary(p_source_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'source_id', p_source_id,
    'total', count(*),
    'matched', count(*) FILTER (WHERE status = 'matched'),
    'unreviewed', count(*) FILTER (WHERE status = 'unreviewed'),
    'ignored', count(*) FILTER (WHERE status = 'ignored'),
    -- Only money LEAVING is a candidate expense. A deposit on a card statement
    -- is a refund or a payment and is not something to log as a cost.
    'unreviewed_spend_cents',
      coalesce(-sum(amount_cents) FILTER (
        WHERE status = 'unreviewed' AND amount_cents < 0), 0),
    'first_posted', min(posted_on),
    'last_posted', max(posted_on)
  )
  FROM public.statement_rows
  WHERE source_id = p_source_id;
$fn$;

grant execute on function public.statement_import_summary(uuid) to authenticated;
grant execute on function public.statement_import_summary(uuid) to service_role;

comment on table public.statement_rows is
  'US-2994 a line from a bank or card CSV, kept as its own record. matched_expense_id is a LINK and never mutates the expense: an import that rewrites an amount a seller typed is how a bookkeeping tool silently disagrees with the person using it. row_fingerprint keys idempotency off the ROW, so re-importing an overlapping range is the normal case rather than a duplicate.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00701') on conflict do nothing;
