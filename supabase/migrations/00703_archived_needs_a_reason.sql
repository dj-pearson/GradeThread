-- US-3007's last criterion: the one status a trigger must not resolve.
--
-- 00690 gave inventory_items removed_on/removed_reason and taught
-- take_inventory_snapshot to honour them. 00692 derives the pair from
-- item_status, and the owner's ruling settled three of the four: 'keeping'
-- leaves inventory, 'wearing' and 'returned' stay. 'archived' was left alone
-- because it is genuinely ambiguous - lost, damaged, donated and sold
-- off-platform are four answers with four different tax treatments.
--
-- WHY A QUEUE AND NOT A PROMPT. At least four surfaces set item status
-- (composer's item-details-card, inline-status-select, the listings bulk
-- action, the command palette). A dialog on each is four dialogs to keep in
-- sync and an interruption on a routine board tidy-up. An archived item with no
-- reason only matters when the seller works out COGS - which is exactly what
-- US-2992's review queue is for, and it exists now.
--
-- SAFE BY DEFAULT WHILE UNANSWERED: the item stays in ending inventory, so the
-- books overstate rather than understate. Nobody under-reports because this is
-- unread.

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
    UNION ALL
    -- 7. Archived with no reason recorded (US-3007). 'archived' is the one
    -- status the removal trigger will not resolve, because lost / damaged /
    -- donated / sold off-platform are four different answers to one word, and
    -- they do not go to the same place on the return.
    --
    -- The item still counts as stock until someone says, so ending inventory is
    -- too high and cost of goods sold too low. That direction OVERSTATES tax,
    -- which is why the trigger leaves archived alone rather than guessing.
    SELECT 'archived_no_reason',
           i.id::text,
           coalesce(nullif(btrim(i.title), ''), 'Untitled item'),
           -- Approximate, and only ever used to place the row in a period.
           -- Nothing records WHEN an item was archived; this is the same gap
           -- the 00692 backfill hit and the same answer given there. It never
           -- reaches a figure.
           i.updated_at::date,
           -- Exact, not estimated: ending inventory is overstated by precisely
           -- what the item cost, and that is recorded. Null stays null rather
           -- than being guessed, which is the rule this queue already keeps.
           CASE WHEN i.acquired_price IS NULL THEN NULL
                ELSE (i.acquired_price * 100)::bigint END,
           NULL::bigint,
           -- Severity 2. Severity 1 is for a figure that cannot be
           -- reconstructed; this one is one question away from correct, and the
           -- default already errs toward paying more rather than less.
           2,
           'item'
      FROM public.inventory_items i
     -- No explicit user filter, matching the six branches above: the function
     -- is SECURITY INVOKER and inventory_items carries RLS, so a real caller
     -- sees only their own rows. An extra `user_id = auth.uid()` here would be
     -- redundant in production AND wrong under a superuser session, where RLS
     -- is bypassed but auth.uid() is null - which is exactly how the db-lane
     -- fixture runs, and it silently returned nothing.
     WHERE i.status = 'archived'
       AND i.removed_reason IS NULL
       AND i.acquired_date IS NOT NULL
       AND i.acquired_date::date < p_to
       AND NOT EXISTS (
         SELECT 1 FROM public.sales s
          WHERE s.inventory_item_id = i.id
            AND s.status = 'completed'
            AND s.sale_date::date < p_to
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

insert into public.applied_migrations (version) values ('00703') on conflict do nothing;
