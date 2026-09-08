-- US-3189: record when each order has to be handed to the carrier.
--
-- Late shipment is the one metric a marketplace scores a seller on that the
-- seller can lose purely by not looking. Nothing in FlipDesk knew the deadline
-- existed: sales carried sold_at and shipped_at, so the app could say an order
-- was unshipped but never that it was LATE, and needs-you.ts — the ranked list
-- of everything running out — had no shipping entry at all.
--
-- TWO COLUMNS, NOT ONE, because they answer different questions and fail
-- differently. ship_by is eBay's own answer, read off
-- lineItems[].lineItemFulfillmentInstructions.shipByDate; handling_days is the
-- listing's handling time, which is what lets a deadline be derived for a sale
-- eBay gave no shipByDate for (and for a marketplace that has no such field at
-- all). Storing only the derived date would lose which of the two it came from,
-- and a derived deadline is a weaker claim than eBay's own.
--
-- NULL IS THE HONEST ANSWER, not a guessed date. An order with neither a
-- shipByDate nor a handling time has no deadline we can stand behind, and
-- inventing one would put a red overdue badge on an order that is fine. The
-- Ship queue sorts null last for exactly that reason — the same rule
-- needs-you.ts already applies to every other deadline-less item.
--
-- DEPLOY ORDER: database first. The eBay order sync WRITES these columns, so an
-- edge carrying that code against a database without them fails the sale upsert
-- with 42703 and the whole order sync throws. The schema-version boot guard
-- enforces it — EXPECTED_SCHEMA_VERSION moves to 00768 in this same commit.
-- Nothing reads the columns before they exist, so the reverse order (database
-- ahead of the edge) is a no-op.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS ship_by       timestamptz,
  ADD COLUMN IF NOT EXISTS handling_days smallint;

COMMENT ON COLUMN public.sales.ship_by IS
  'When this order must be handed to the carrier. From eBay lineItemFulfillmentInstructions.shipByDate, else derived from sold_at + handling_days. NULL when neither is known — never a guess.';
COMMENT ON COLUMN public.sales.handling_days IS
  'Business days the listing promised between payment and dispatch. Used to derive ship_by when the marketplace reports no explicit date.';

-- The Ship queue''s only query: this tenant''s unshipped orders, soonest first.
-- Partial on shipped_at IS NULL so the index stays the size of the open queue
-- rather than the whole sales history, which is what it is scanned as.
CREATE INDEX IF NOT EXISTS idx_sales_ship_by_open
  ON public.sales(user_id, ship_by)
  WHERE shipped_at IS NULL;

insert into public.applied_migrations (version) values ('00768') on conflict do nothing;
