-- FlipDesk → eBay: store the Sell Fulfillment API orderId on sales rows.
--
-- The orderId is the natural idempotency key for sales sync. Without it,
-- re-running /listings/pull would create duplicate sales rows for the same
-- transaction. (sale_date + buyer + item is a fuzzy match — eBay can have
-- two sales of the same SKU to the same buyer in a day.)
--
-- A unique index on (inventory_item_id, platform_order_id) lets the sync
-- upsert safely. NULL values are allowed for sales recorded manually or
-- from CSV imports that don't carry an orderId.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS platform_order_id text;

-- Unique only when both fields are present; allows NULL combinations for
-- manually-recorded sales.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_platform_order_id_unique
  ON public.sales(inventory_item_id, platform_order_id)
  WHERE platform_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_platform_order_id
  ON public.sales(platform_order_id)
  WHERE platform_order_id IS NOT NULL;
