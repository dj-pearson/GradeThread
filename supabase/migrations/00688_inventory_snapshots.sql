-- US-2986: ending inventory, and the COGS worksheet that needs it.
--
-- Schedule C Part III asks for inventory at the beginning of the year (line 35)
-- and at the end of it (line 41). Nothing in this schema could answer either.
-- Worse, the answer DECAYS: `inventory_items.acquired_price` is editable, so the
-- moment a seller corrects last year's cost, last year's ending inventory
-- silently changes -- and last year's ending inventory is this year's beginning
-- inventory. This is the one gap in the Books and Taxes epic that gets harder
-- to close the longer it is left.
--
-- The rules, and why the count of unpriced items is stored beside the total,
-- are in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.inventory_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- The instant the inventory is valued AT. Exclusive: a snapshot "as of
  -- 2027-01-01" is the close of business on 2026-12-31, which is what makes one
  -- year's ending snapshot usable as the next year's beginning without an
  -- off-by-one day.
  as_of         date NOT NULL,
  -- "2026" or "2026-27". Free text because a fiscal year label is a label.
  fiscal_label  text NOT NULL,

  total_cost_cents  bigint NOT NULL DEFAULT 0,
  item_count        integer NOT NULL DEFAULT 0,

  -- THE NUMBER THAT MUST NOT HIDE IN THE TOTAL.
  --
  -- An item with no acquired_price contributes zero, which understates
  -- inventory and therefore overstates the deduction. A total of $4,200 across
  -- 80 items reads very differently when 30 of them were valued at nothing, and
  -- a seller who cannot see that count cannot know to go and fix it.
  items_without_cost integer NOT NULL DEFAULT 0,

  -- true when this was rebuilt after the fact from whatever data survived,
  -- rather than recorded at the time. The distinction is the difference between
  -- a record and an estimate, and the packet prints it.
  reconstructed boolean NOT NULL DEFAULT false,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, as_of)
);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_user
  ON public.inventory_snapshots(user_id, as_of DESC);

-- Per-item detail, frozen. This is what makes the snapshot survive a later edit
-- to acquired_price: the cost is COPIED here, not referenced. The item link is
-- ON DELETE SET NULL so deleting an item does not rewrite a year already filed.
CREATE TABLE IF NOT EXISTS public.inventory_snapshot_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id   uuid NOT NULL
                  REFERENCES public.inventory_snapshots(id) ON DELETE CASCADE,
  item_id       uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  title         text,
  cost_cents    bigint,
  acquired_on   date
);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshot_items_snapshot
  ON public.inventory_snapshot_items(snapshot_id);

DROP TRIGGER IF EXISTS set_inventory_snapshots_updated_at
  ON public.inventory_snapshots;
CREATE TRIGGER set_inventory_snapshots_updated_at
  BEFORE UPDATE ON public.inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_snapshot_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own snapshots" ON public.inventory_snapshots;
CREATE POLICY "Users can view own snapshots"
  ON public.inventory_snapshots FOR SELECT
  USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "Users can delete own snapshots" ON public.inventory_snapshots;
CREATE POLICY "Users can delete own snapshots"
  ON public.inventory_snapshots FOR DELETE
  USING ((select auth.uid()) = user_id);

-- No INSERT or UPDATE policy, deliberately. A snapshot is a RECORD, and a
-- record a user can hand-write is not a record. They are created only by
-- take_inventory_snapshot() below, which counts the items itself. Delete is
-- allowed because a seller who took one on the wrong date needs a way out.

DROP POLICY IF EXISTS "Users can view own snapshot items"
  ON public.inventory_snapshot_items;
CREATE POLICY "Users can view own snapshot items"
  ON public.inventory_snapshot_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.inventory_snapshots s
     WHERE s.id = snapshot_id AND s.user_id = (select auth.uid())
  ));


-- ── Taking a snapshot ──────────────────────────────────────────────────────
--
-- What counts as "on hand at `as_of`": acquired before that date, and not sold
-- before it. Both halves matter. Filtering on the CURRENT status column would
-- make every historical snapshot wrong the moment an item's status moved, which
-- is exactly the decay this table exists to stop -- so the predicate is built
-- from DATES, which do not change retroactively.

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

-- The seller-callable wrapper. SECURITY INVOKER, so the authorization is the
-- caller's identity rather than anything they pass. No REVOKE anywhere here:
-- on this Postgres image a denied EXECUTE from anon or authenticated restarts
-- the database (US-2403), so authorization lives in the body and raises an
-- ordinary 42501. Same shape as 00686.
CREATE OR REPLACE FUNCTION public.take_my_inventory_snapshot(
  p_as_of         date,
  p_fiscal_label  text,
  p_reconstructed boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF (select auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  RETURN public.take_inventory_snapshot(
    (select auth.uid()), p_as_of, p_fiscal_label, p_reconstructed);
END;
$$;

grant execute on function public.take_inventory_snapshot(uuid, date, text, boolean)
  to service_role;
grant execute on function public.take_my_inventory_snapshot(date, text, boolean)
  to authenticated;
grant execute on function public.take_my_inventory_snapshot(date, text, boolean)
  to service_role;


-- ── The COGS worksheet ─────────────────────────────────────────────────────
--
-- Schedule C Part III, plus the cross-check that says whether to trust it.
--
--   line 35  beginning inventory   = the snapshot at p_from
--   line 36  purchases             = items acquired inside the period
--   line 41  ending inventory      = the snapshot at p_to
--   line 42  COGS                  = 35 + 36 - 41
--
-- AND SEPARATELY, from the ledger: the sum of the cost basis of the items
-- actually SOLD in the period. Those two should be the same number. When they
-- are not, something is missing -- an item sold that was never in inventory, an
-- item acquired with no cost, a write-off -- and the difference is reported
-- rather than smoothed over, because a COGS figure nobody can reconcile is a
-- COGS figure an accountant has to redo from scratch.

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
    'line_36_purchases_cents', (SELECT cents FROM purchases),
    'line_41_ending_cents',    coalesce((SELECT total_cost_cents FROM ending), 0),
    'line_41_present',         (SELECT count(*) FROM ending) > 0,
    'line_41_reconstructed',   coalesce((SELECT reconstructed FROM ending), false),
    'line_42_cogs_cents',
      coalesce((SELECT total_cost_cents FROM beginning), 0)
      + (SELECT cents FROM purchases)
      - coalesce((SELECT total_cost_cents FROM ending), 0),
    'sold_cost_basis_cents',   (SELECT cents FROM sold),
    'sold_item_count',         (SELECT cnt FROM sold),
    'variance_cents',
      (coalesce((SELECT total_cost_cents FROM beginning), 0)
       + (SELECT cents FROM purchases)
       - coalesce((SELECT total_cost_cents FROM ending), 0))
      - (SELECT cents FROM sold),
    'items_without_cost', jsonb_build_object(
      'beginning', coalesce((SELECT items_without_cost FROM beginning), 0),
      'purchases', (SELECT nulls FROM purchases),
      'ending',    coalesce((SELECT items_without_cost FROM ending), 0)
    ),
    'purchase_item_count', (SELECT cnt FROM purchases)
  );
$$;

grant execute on function public.cogs_worksheet(date, date) to authenticated;
grant execute on function public.cogs_worksheet(date, date) to service_role;

-- Sold items in a period that carry NO cost basis. This is the list the
-- worksheet points at when the variance is non-zero: each one overstates profit
-- by exactly what it cost, and that is a number the seller can go and find.
CREATE OR REPLACE FUNCTION public.items_missing_cost_basis(
  p_from date,
  p_to   date
)
RETURNS TABLE (
  item_id   uuid,
  title     text,
  sale_date date,
  sale_price_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT i.id, i.title, s.sale_date::date, (s.sale_price * 100)::bigint
    FROM public.sales s
    JOIN public.inventory_items i ON i.id = s.inventory_item_id
   WHERE s.status = 'completed'
     AND s.sale_date::date >= p_from
     AND s.sale_date::date <  p_to
     AND (i.acquired_price IS NULL OR i.acquired_price = 0)
   ORDER BY s.sale_date DESC;
$$;

grant execute on function public.items_missing_cost_basis(date, date) to authenticated;
grant execute on function public.items_missing_cost_basis(date, date) to service_role;

comment on table public.inventory_snapshots is
  'US-2986 point-in-time inventory valuation for Schedule C Part III lines 35 and 41. Costs are COPIED into inventory_snapshot_items, so a later edit to acquired_price cannot rewrite a year already filed. items_without_cost is stored beside the total because an unpriced item contributes zero and understates inventory.';
comment on function public.cogs_worksheet(date, date) is
  'US-2986 Part III lines 35, 36, 41, 42 plus the ledger cross-check. variance_cents non-zero means the two routes to COGS disagree; items_missing_cost_basis() names the likely cause.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00688') on conflict do nothing;
