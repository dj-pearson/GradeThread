-- US-2992: books health. The review queue that tells a seller what is wrong
-- before their accountant does.
--
-- QuickBooks' actual hook is not its reports, it is the badge saying "N
-- transactions need your review". GradeThread has the same problem set and no
-- surface for it: items sold with no cost basis, entries on 'uncategorised',
-- payouts that never matched a sale, sales with no fees recorded, expenses over
-- the substantiation threshold with no receipt, and a finished year with no
-- inventory snapshot. Each quietly corrupts a report and none is visible until
-- someone reconciles by hand.
--
-- WHERE THE DOLLAR IMPACT IS HONESTLY UNKNOWN. AC3 asks the queue to say what
-- each issue costs. For most it is exact. For a sold item with NO cost basis it
-- is not: profit is overstated by whatever the item cost, and the whole problem
-- is that nobody recorded that. Inventing a figure there would be the same
-- mistake in a different place, so those rows carry an ESTIMATE from the
-- seller's own median cost-to-price ratio, labelled as one, and null when there
-- is not enough of their history to derive it.
--
-- The rules are in vault/50-business/books-and-taxes.md.

-- A seller who knows an item was a gift should not be asked about it for ever.
-- The dismissal is RECORDED with a reason rather than silent, so a later reader
-- can tell "resolved" from "hidden".
CREATE TABLE IF NOT EXISTS public.books_review_dismissals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  issue_kind   text NOT NULL,
  -- The thing the issue is about. TEXT rather than uuid because one kind is
  -- about a YEAR ('2025') rather than a record, and a nullable uuid plus a
  -- nullable year would be two columns that must never both be set.
  subject_id   text NOT NULL,

  reason       text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, issue_kind, subject_id)
);

DO $$ BEGIN
  ALTER TABLE public.books_review_dismissals
    ADD CONSTRAINT books_review_reason_check CHECK (btrim(reason) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_books_review_dismissals_user
  ON public.books_review_dismissals(user_id);

ALTER TABLE public.books_review_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own dismissals"
  ON public.books_review_dismissals;
CREATE POLICY "Users can view own dismissals"
  ON public.books_review_dismissals FOR SELECT
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can create own dismissals"
  ON public.books_review_dismissals;
CREATE POLICY "Users can create own dismissals"
  ON public.books_review_dismissals FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own dismissals"
  ON public.books_review_dismissals;
CREATE POLICY "Users can delete own dismissals"
  ON public.books_review_dismissals FOR DELETE
  USING ((select auth.uid()) = user_id);
-- No UPDATE policy, deliberately: editing a recorded reason after the fact
-- turns the record into whatever the last edit said. Undismiss and dismiss again.


-- The seller's own median cost-to-price ratio, from items where BOTH are known.
--
-- Used only to estimate what a missing cost basis probably was. Returns NULL
-- under five completed sales: a ratio from two items is a guess dressed as a
-- statistic, and the queue says "we cannot tell" rather than showing it.
CREATE OR REPLACE FUNCTION public.median_cost_ratio_bps(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT CASE WHEN count(*) >= 5
    THEN (percentile_cont(0.5) WITHIN GROUP (
            ORDER BY i.acquired_price / s.sale_price) * 10000)::integer
    ELSE NULL END
    FROM public.sales s
    JOIN public.inventory_items i ON i.id = s.inventory_item_id
   WHERE s.user_id = p_user_id
     AND s.status = 'completed'
     AND s.sale_price > 0
     AND i.acquired_price IS NOT NULL
     AND i.acquired_price > 0;
$fn$;

grant execute on function public.median_cost_ratio_bps(uuid) to authenticated;
grant execute on function public.median_cost_ratio_bps(uuid) to service_role;


-- The queue.
--
-- SECURITY INVOKER, and every source table is RLS-scoped to the caller, so there
-- is no user_id parameter to get wrong. Half-open range like everything else in
-- this epic.
--
-- Severity drives ORDER, and the order is by what it costs the seller to leave
-- it alone rather than by how easy it is to fix.
CREATE OR REPLACE FUNCTION public.books_review_queue(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH ratio AS (
    SELECT public.median_cost_ratio_bps((select auth.uid())) AS bps
  ),
  issues AS (
    -- 1. Sold with no cost basis. Overstates profit by whatever it cost, and
    -- nobody knows what that was.
    SELECT
      'no_cost_basis'::text AS kind,
      i.id::text            AS subject_id,
      coalesce(nullif(btrim(i.title), ''), 'Untitled item') AS title,
      s.sale_date::date     AS happened_on,
      NULL::bigint          AS impact_cents,
      CASE WHEN (SELECT bps FROM ratio) IS NOT NULL
           THEN round((s.sale_price * 100) * (SELECT bps FROM ratio) / 10000)::bigint
           ELSE NULL END    AS estimated_impact_cents,
      1                     AS severity,
      'item'::text          AS fix_kind
      FROM public.sales s
      JOIN public.inventory_items i ON i.id = s.inventory_item_id
     WHERE s.status = 'completed'
       AND s.sale_date::date >= p_from AND s.sale_date::date < p_to
       AND (i.acquired_price IS NULL OR i.acquired_price = 0)

    UNION ALL
    -- 2. Expenses that reach no Schedule C line. The whole amount is a
    -- deduction the seller is entitled to and is not taking.
    SELECT 'uncategorised', x.id::text,
           coalesce(nullif(btrim(x.description), ''), 'Unsorted expense'),
           x.spent_on,
           (x.amount * 100)::bigint,
           NULL::bigint,
           2,
           'expense'
      FROM public.flipdesk_expenses x
      LEFT JOIN public.ledger_accounts a ON a.id = x.account_id
     WHERE x.spent_on >= p_from AND x.spent_on < p_to
       AND x.amount <> 0
       AND coalesce(a.code, public.default_account_for_category(x.category))
           = 'uncategorised'

    UNION ALL
    -- 3. A completed sale with NO fees at all. Every marketplace charges
    -- something, so a zero is almost always an import that dropped them --
    -- which understates the deduction and overstates profit.
    SELECT 'sale_without_fees', s.id::text,
           coalesce(nullif(btrim(i.title), ''), 'Sale'),
           s.sale_date::date,
           NULL::bigint,
           NULL::bigint,
           3,
           'sale'
      FROM public.sales s
      LEFT JOIN public.inventory_items i ON i.id = s.inventory_item_id
      LEFT JOIN public.listings l ON l.id = s.listing_id
     WHERE s.status = 'completed'
       AND s.sale_date::date >= p_from AND s.sale_date::date < p_to
       AND (s.platform_fees + s.payment_processing_fees) = 0
       AND s.sale_price > 0
       -- A local cash pickup genuinely has no fees. Only flag channels that
       -- always charge.
       AND l.platform IS NOT NULL
       AND l.platform NOT IN ('other', 'facebook', 'offerup')

    UNION ALL
    -- 4. Money that arrived against no sale. Either a sale is missing or the
    -- payout is double-counted; both matter and neither is visible.
    SELECT 'unmatched_payout', p.id::text,
           'Payout ' || p.payout_id,
           p.payout_date::date,
           p.amount_cents,
           NULL::bigint,
           2,
           'payout'
      FROM public.ebay_payouts p
     WHERE p.payout_date::date >= p_from AND p.payout_date::date < p_to
       AND p.amount_cents IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.sales s
          WHERE s.payout_reference = p.payout_id
       )

    UNION ALL
    -- 5. A sizeable expense with no receipt. The deduction is not wrong, but it
    -- is the one that cannot be defended if anybody asks.
    SELECT 'missing_receipt', x.id::text,
           coalesce(nullif(btrim(x.description), ''), 'Expense'),
           x.spent_on,
           (x.amount * 100)::bigint,
           NULL::bigint,
           4,
           'expense'
      FROM public.flipdesk_expenses x
     WHERE x.spent_on >= p_from AND x.spent_on < p_to
       AND x.receipt_path IS NULL
       -- $75 is the IRS's own substantiation threshold for most expenses.
       -- Below it, chasing a receipt costs more than it protects.
       AND x.amount >= 75

    UNION ALL
    -- 6. A finished year with no inventory valuation. Schedule C Part III lines
    -- 35 and 41 cannot be answered at all, and the answer decays: once
    -- acquired_price is edited, that year's figure is unrecoverable.
    SELECT 'no_inventory_snapshot',
           to_char(y.boundary, 'YYYY-MM-DD'),
           'Inventory was never counted at ' || to_char(y.boundary, 'DD Mon YYYY'),
           y.boundary,
           NULL::bigint,
           NULL::bigint,
           2,
           'snapshot'
      FROM (
        SELECT make_date(yr, 1, 1) AS boundary
          FROM generate_series(
                 extract(year from p_from)::int,
                 extract(year from (p_to - 1))::int + 1) AS yr
      ) y
     WHERE y.boundary <= current_date
       AND NOT EXISTS (
         SELECT 1 FROM public.inventory_snapshots s WHERE s.as_of = y.boundary
       )
       -- Only worth asking about once there is something to count.
       AND EXISTS (
         SELECT 1 FROM public.inventory_items i
          WHERE i.acquired_date IS NOT NULL
            AND i.acquired_date::date < y.boundary
       )
  ),
  live AS (
    SELECT i.* FROM issues i
     WHERE NOT EXISTS (
       SELECT 1 FROM public.books_review_dismissals d
        WHERE d.issue_kind = i.kind AND d.subject_id = i.subject_id
     )
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', kind,
        'subject_id', subject_id,
        'title', title,
        'happened_on', happened_on,
        'impact_cents', impact_cents,
        'estimated_impact_cents', estimated_impact_cents,
        'severity', severity,
        'fix_kind', fix_kind
      )
      ORDER BY severity, happened_on DESC
    ),
    '[]'::jsonb)
  FROM live;
$fn$;

grant execute on function public.books_review_queue(date, date) to authenticated;
grant execute on function public.books_review_queue(date, date) to service_role;

-- Just the number, for the nav badge (AC5). A separate function so the badge
-- does not pull the whole queue on every page load.
CREATE OR REPLACE FUNCTION public.books_review_count(p_from date, p_to date)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_array_length(public.books_review_queue(p_from, p_to));
$fn$;

grant execute on function public.books_review_count(date, date) to authenticated;
grant execute on function public.books_review_count(date, date) to service_role;

comment on table public.books_review_dismissals is
  'US-2992 a dismissed review issue, WITH a reason. Recorded rather than silent so a later reader can tell "resolved" from "hidden". No UPDATE policy: editing a reason after the fact turns the record into whatever the last edit said.';
comment on function public.books_review_queue(date, date) is
  'US-2992 the review queue. impact_cents is exact where it can be; estimated_impact_cents carries a figure derived from the seller''s own median cost ratio for the one issue whose true cost is by definition unrecorded, and both are null when neither can be honestly given.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00699') on conflict do nothing;
