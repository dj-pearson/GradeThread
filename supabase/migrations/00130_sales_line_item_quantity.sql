-- US-468: multi-quantity / multi-line eBay orders.
--
-- Two gaps in the orders→sales sync:
--   1. Unit count wasn't recorded. eBay's lineItem.quantity can be >1 (a buyer
--      buys 3 of a multi-quantity listing); we stored the sale but not how many
--      units. (Revenue was already correct: eBay's lineItemCost is the EXTENDED
--      line total — unit price × quantity — NOT a per-unit price, so we must
--      never multiply sale_price by quantity again.)
--   2. The matched-sale dedupe key was (inventory_item_id, platform_order_id).
--      A single order can carry MULTIPLE line items that resolve to the SAME
--      inventory item (the same SKU listed twice, or two listings merged onto
--      one item). Those distinct lines collapsed onto one sale row, losing
--      revenue. Adding line_item_id to the key disambiguates them.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS line_item_id text,
  ADD COLUMN IF NOT EXISTS quantity     integer NOT NULL DEFAULT 1;

-- Defensive: a unit count is always ≥ 1. (Manual sales default to 1.)
ALTER TABLE public.sales
  DROP CONSTRAINT IF EXISTS sales_quantity_positive;
ALTER TABLE public.sales
  ADD CONSTRAINT sales_quantity_positive CHECK (quantity >= 1);

-- Replace the old unique index with one that disambiguates line items within an
-- order. COALESCE(line_item_id,'') preserves the OLD behaviour for legacy rows
-- (NULL line id → one row per item+order) while letting eBay-sourced rows with
-- a real line_item_id coexist for the same item+order.
DROP INDEX IF EXISTS idx_sales_platform_order_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_order_line_unique
  ON public.sales(inventory_item_id, platform_order_id, COALESCE(line_item_id, ''))
  WHERE platform_order_id IS NOT NULL;

-- Orphan sales (eBay lines we couldn't match to inventory) get the same unit
-- count so Sold totals and a future link-to-inventory carry the right quantity.
ALTER TABLE public.flipdesk_ebay_orphan_sales
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
ALTER TABLE public.flipdesk_ebay_orphan_sales
  DROP CONSTRAINT IF EXISTS orphan_sales_quantity_positive;
ALTER TABLE public.flipdesk_ebay_orphan_sales
  ADD CONSTRAINT orphan_sales_quantity_positive CHECK (quantity >= 1);
