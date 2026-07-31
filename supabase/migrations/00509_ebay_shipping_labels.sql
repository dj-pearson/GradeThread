-- US-2160: buying an eBay shipping label inside FlipDesk.
--
-- Three columns, two concerns.
--
-- marketplace_connections.logistics_access_denied mirrors the existing
-- negotiation_access_denied (00345) and analytics_access_denied: a sticky flag
-- set when THIS connection's token 403s a /sell/logistics call, so the label
-- surfaces can be disabled for that seller without re-probing eBay on every
-- render. Sell Logistics is a limited-release API whose scope is granted per
-- keyset, so "the deployment asks for the scope but this token predates the
-- grant" is a real, recoverable state that a reconnect fixes.
--
-- sales.ebay_shipment_id + sales.label_purchased_at record the purchase. The
-- shipment id is what a reprint and a void both need — eBay's label download
-- URLs expire, so the URL itself is deliberately NOT stored; it is re-fetched
-- from the shipment on demand. label_purchased_at distinguishes "we bought this
-- postage" from "the seller typed a tracking number they bought elsewhere",
-- which is the difference between a shipping_cost we can stand behind and one
-- that came from memory.
--
-- The label price lands in the EXISTING sales.shipping_cost (00008), so
-- Finances and the per-item P&L need no change to pick it up.

ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS logistics_access_denied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.marketplace_connections.logistics_access_denied IS
  'US-2160: true once a /sell/logistics call 403d on this connection''s token (missing sell.logistics scope). Cleared on any successful logistics call. Mirrors negotiation_access_denied.';

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS ebay_shipment_id   text,
  ADD COLUMN IF NOT EXISTS label_purchased_at timestamptz;

COMMENT ON COLUMN public.sales.ebay_shipment_id IS
  'US-2160: eBay Sell Logistics shipmentId for a label bought in FlipDesk. Used to reprint (label URLs expire, so re-fetch rather than store) and to void.';
COMMENT ON COLUMN public.sales.label_purchased_at IS
  'US-2160: when the label was bought here. Null means the tracking number came from outside FlipDesk, so shipping_cost is seller-entered rather than the real postage.';

-- The reprint/void path looks a sale up by its shipment id when eBay calls back
-- or the seller retries; partial because almost no sale has one.
CREATE INDEX IF NOT EXISTS idx_sales_ebay_shipment_id
  ON public.sales (ebay_shipment_id)
  WHERE ebay_shipment_id IS NOT NULL;

insert into public.applied_migrations (version) values ('00509') on conflict do nothing;
