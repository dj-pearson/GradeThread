-- US-3007: an item that is lost, donated or kept never left inventory.
--
-- take_inventory_snapshot decides what a seller was holding with a DATE-based
-- predicate: acquired before as_of, and not sold before as_of. That is right,
-- and 00688 explains why - filtering on the current status column would make
-- every historical snapshot wrong the moment an item's status moved.
--
-- But it made a completed SALE the only way out. An item that is lost, damaged
-- beyond selling, donated, returned to a consignor or taken for personal use sat
-- in ending inventory permanently. Schedule C Part III line 41 was therefore
-- overstated, which understates line 42 COGS, which OVERSTATES profit and the
-- tax paid on it. It is the rare bug that costs the seller money in the
-- government's favour.
--
-- WHY A DATE AND NOT A STATUS. item_status already has 'archived' and
-- 'returned'. Neither is read by the predicate and neither records WHEN it
-- happened, which is exactly what a date-based predicate needs. Overloading them
-- would reproduce the decay problem 00688 was written to avoid.
--
-- ⚠ PERSONAL USE IS NOT THE SAME AS A LOSS, and the form says so on its face.
-- Schedule C Part III line 36 reads "Purchases less cost of items withdrawn for
-- personal use". So a personal-use withdrawal reduces PURCHASES in the year of
-- withdrawal; the other four reasons reduce ENDING INVENTORY and flow through
-- line 42. Both routes are implemented below and they are deliberately
-- different arithmetic. Note the withdrawal reduces purchases in the period it
-- was WITHDRAWN, not the period it was acquired - the item may have been bought
-- years earlier.
--
-- ⚠ A WRITE-OFF IS NOT AUTOMATICALLY A DEDUCTION and nothing here books one.
-- No ledger entry is written. The worksheet reports write-offs as their own
-- figure so a non-zero variance reads as "these items left without selling"
-- rather than as broken books. Recording the reason and naming what it feeds is
-- the whole job; deciding the deduction is the seller's and their accountant's.
--
-- NO INDEX, deliberately. removed_on is NULL for approximately every row, the
-- predicate is "IS NULL OR >= date" which indexes poorly, and the snapshot is a
-- once-per-user batch read. An index here would be storage and write cost with
-- nothing to show for it.
--
-- EXISTING SNAPSHOTS ARE NOT REWRITTEN. This changes what FUTURE snapshots
-- record. Rows already taken are what was believed at the time; US-2995 (period
-- close) is the mechanism for correcting a closed year, with an adjusting entry
-- in the open period rather than an edit to history.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS removed_on date;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS removed_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_removed_reason_chk'
  ) THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_removed_reason_chk
      CHECK (removed_reason IS NULL OR removed_reason IN
        ('lost', 'damaged', 'donated', 'personal_use', 'returned_to_consignor'));
  END IF;
END $$;

-- A reason without a date cannot be read historically, and a date without a
-- reason cannot be routed to the right line of the form. Neither half is useful
-- alone, so require both or neither.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_removed_pair_chk'
  ) THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_removed_pair_chk
      CHECK ((removed_on IS NULL) = (removed_reason IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.inventory_items.removed_on IS
  'US-3007: the date an item left inventory WITHOUT being sold. NULL means it is still held. Read by take_inventory_snapshot the same way a completed sale is.';
COMMENT ON COLUMN public.inventory_items.removed_reason IS
  'US-3007: why it left. personal_use reduces Schedule C line 36 (purchases); the others reduce ending inventory and flow through line 42.';


-- --------------------------------------------------------------------------
-- take_inventory_snapshot: one clause. Re-emitted whole because a plpgsql
-- body cannot be patched, which means the US-3008 authorization guard is
-- carried forward BY HAND. definer-user-id-guard_test.ts scans migrations
-- above 00640 for exactly the shape that results if it is dropped, so this
-- re-emit is checked rather than trusted.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.take_inventory_snapshot(
  p_user_id       uuid,
  p_as_of         date,
  p_fiscal_label  text,
  p_reconstructed boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot_id uuid;
BEGIN
  -- ⚠ THE AUTHORIZATION CHECK, and it is NOT optional just because the grant
  -- below names service_role.
  --
  -- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and a later
  -- `grant ... to service_role` ADDS a grant rather than removing that one.
  -- Only a REVOKE would remove it, and a REVOKE is exactly what must not be
  -- written on this image (US-2403: a denied call restarts the database). So
  -- without this block any authenticated caller could invoke
  -- take_inventory_snapshot with SOMEBODY ELSE'S user id and delete and
  -- replace their snapshots - the function DELETEs by p_user_id on the line
  -- below.
  --
  -- Same shape as 00686's rebuild_ledger_for_user, and for the same reason:
  -- when the grant cannot protect a SECURITY DEFINER function that takes a
  -- caller-supplied id, the body has to.
  IF auth.role() IS NOT NULL
     AND auth.role() <> 'service_role'
     AND ((select auth.uid()) IS NULL OR (select auth.uid()) <> p_user_id)
  THEN
    RAISE EXCEPTION 'take_inventory_snapshot: may only snapshot your own inventory'
      USING ERRCODE = '42501';
  END IF;

  -- Re-taking a snapshot for the same date REPLACES it. A seller who fixes a
  -- cost basis and re-runs should get the corrected figure, and the alternative
  -- (refusing, or accumulating duplicates) is worse than either.
  DELETE FROM public.inventory_snapshots
   WHERE user_id = p_user_id AND as_of = p_as_of;

  INSERT INTO public.inventory_snapshots
    (user_id, as_of, fiscal_label, reconstructed)
  VALUES (p_user_id, p_as_of, p_fiscal_label, p_reconstructed)
  RETURNING id INTO v_snapshot_id;

  INSERT INTO public.inventory_snapshot_items
    (snapshot_id, item_id, title, cost_cents, acquired_on)
  SELECT v_snapshot_id, i.id, i.title,
         CASE WHEN i.acquired_price IS NULL THEN NULL
              ELSE (i.acquired_price * 100)::bigint END,
         i.acquired_date::date
    FROM public.inventory_items i
   WHERE i.user_id = p_user_id
     AND i.acquired_date IS NOT NULL
     AND i.acquired_date::date < p_as_of
     -- US-3007: an item that left WITHOUT selling is gone from that date on.
     -- Same date logic as the sale below, and for the same reason: a status
     -- column read at snapshot time would rewrite history every time an item
     -- moved.
     AND (i.removed_on IS NULL OR i.removed_on >= p_as_of)
     AND NOT EXISTS (
       SELECT 1 FROM public.sales s
        WHERE s.inventory_item_id = i.id
          AND s.status = 'completed'
          AND s.sale_date::date < p_as_of
     );

  UPDATE public.inventory_snapshots s
     SET total_cost_cents = t.total,
         item_count       = t.cnt,
         items_without_cost = t.nulls
    FROM (
      SELECT coalesce(sum(cost_cents), 0) AS total,
             count(*)::integer            AS cnt,
             count(*) FILTER (WHERE cost_cents IS NULL)::integer AS nulls
        FROM public.inventory_snapshot_items
       WHERE snapshot_id = v_snapshot_id
    ) t
   WHERE s.id = v_snapshot_id;

  RETURN v_snapshot_id;
END;
$$;

-- --------------------------------------------------------------------------
-- cogs_worksheet: report what left, and net personal use off line 36.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cogs_worksheet(
  p_from date,
  p_to   date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH beginning AS (
    SELECT total_cost_cents, item_count, items_without_cost, reconstructed
      FROM public.inventory_snapshots
     WHERE as_of = p_from
     LIMIT 1
  ),
  ending AS (
    SELECT total_cost_cents, item_count, items_without_cost, reconstructed
      FROM public.inventory_snapshots
     WHERE as_of = p_to
     LIMIT 1
  ),
  purchases AS (
    SELECT coalesce(sum((i.acquired_price * 100)::bigint), 0) AS cents,
           count(*)::integer AS cnt,
           count(*) FILTER (WHERE i.acquired_price IS NULL)::integer AS nulls
      FROM public.inventory_items i
     WHERE i.acquired_date IS NOT NULL
       AND i.acquired_date::date >= p_from
       AND i.acquired_date::date <  p_to
  ),
  -- What the ledger says the sold items cost. Negative there (a cost), flipped
  -- here so the two figures are comparable without the reader doing sign
  -- arithmetic in their head.
  -- US-3007. Schedule C Part III line 36 is "Purchases less cost of items
  -- withdrawn for personal use", so a personal-use withdrawal reduces PURCHASES
  -- and does so in the period it was WITHDRAWN, which need not be the period it
  -- was acquired.
  personal_use AS (
    SELECT coalesce(sum((i.acquired_price * 100)::bigint), 0) AS cents,
           count(*)::integer AS cnt
      FROM public.inventory_items i
     WHERE i.removed_reason = 'personal_use'
       AND i.removed_on >= p_from
       AND i.removed_on <  p_to
  ),
  -- The other four reasons reduce ENDING INVENTORY and flow through line 42.
  -- Reported rather than booked: nothing here writes a ledger entry, because a
  -- write-off is not automatically a deduction (US-3007 AC3).
  writeoffs AS (
    SELECT coalesce(sum((i.acquired_price * 100)::bigint), 0) AS cents,
           count(*)::integer AS cnt
      FROM public.inventory_items i
     WHERE i.removed_reason IS NOT NULL
       AND i.removed_reason <> 'personal_use'
       AND i.removed_on >= p_from
       AND i.removed_on <  p_to
  ),
  sold AS (
    SELECT coalesce(-sum(e.amount_cents), 0) AS cents,
           count(*)::integer AS cnt
      FROM public.ledger_entries e
      JOIN public.ledger_accounts a ON a.id = e.account_id
     WHERE a.code = 'purchases'
       AND e.entry_date >= p_from
       AND e.entry_date <  p_to
  )
  SELECT jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'line_35_beginning_cents', coalesce((SELECT total_cost_cents FROM beginning), 0),
    'line_35_present',         (SELECT count(*) FROM beginning) > 0,
    'line_35_reconstructed',   coalesce((SELECT reconstructed FROM beginning), false),
    'line_36_purchases_cents',
      (SELECT cents FROM purchases) - (SELECT cents FROM personal_use),
    'line_36_gross_purchases_cents', (SELECT cents FROM purchases),
    'line_36_personal_use_cents',    (SELECT cents FROM personal_use),
    'line_36_personal_use_count',    (SELECT cnt FROM personal_use),
    'line_41_ending_cents',    coalesce((SELECT total_cost_cents FROM ending), 0),
    'line_41_present',         (SELECT count(*) FROM ending) > 0,
    'line_41_reconstructed',   coalesce((SELECT reconstructed FROM ending), false),
    'line_42_cogs_cents',
      coalesce((SELECT total_cost_cents FROM beginning), 0)
      + (SELECT cents FROM purchases) - (SELECT cents FROM personal_use)
      - coalesce((SELECT total_cost_cents FROM ending), 0),
    'sold_cost_basis_cents',   (SELECT cents FROM sold),
    'sold_item_count',         (SELECT cnt FROM sold),
    'variance_cents',
      (coalesce((SELECT total_cost_cents FROM beginning), 0)
       + (SELECT cents FROM purchases) - (SELECT cents FROM personal_use)
       - coalesce((SELECT total_cost_cents FROM ending), 0))
      - (SELECT cents FROM sold),
    'items_without_cost', jsonb_build_object(
      'beginning', coalesce((SELECT items_without_cost FROM beginning), 0),
      'purchases', (SELECT nulls FROM purchases),
      'ending',    coalesce((SELECT items_without_cost FROM ending), 0)
    ),
    'purchase_item_count', (SELECT cnt FROM purchases),
    -- US-3007: what left without selling, so a non-zero variance reads as
    -- "these items left inventory" rather than as books that do not balance.
    'writeoffs_cents',      (SELECT cents FROM writeoffs),
    'writeoff_item_count',  (SELECT cnt FROM writeoffs),
    -- The residual once write-offs are accounted for. THIS is the figure that
    -- should be zero; variance_cents alone will not be once anything has been
    -- written off, and that is correct rather than a fault.
    'variance_after_writeoffs_cents',
      (coalesce((SELECT total_cost_cents FROM beginning), 0)
       + (SELECT cents FROM purchases) - (SELECT cents FROM personal_use)
       - coalesce((SELECT total_cost_cents FROM ending), 0))
      - (SELECT cents FROM sold)
      - (SELECT cents FROM writeoffs)
  );
$$;

insert into public.applied_migrations (version) values ('00690') on conflict do nothing;
