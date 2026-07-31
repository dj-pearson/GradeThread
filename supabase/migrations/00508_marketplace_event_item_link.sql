-- US-2156: link a marketplace event back to the listing it happened on.
--
-- marketplace_event_notifications (00247) is the ledger the US-1055 poll writes
-- one row into the first time it sees each open offer / return / dispute. It
-- records WHICH event (bestOfferId / returnId / paymentDisputeId) but not WHAT
-- it happened to, so nothing downstream could answer "did this listing get an
-- offer this week?" — which is exactly what the offer_received and
-- return_opened automation triggers need.
--
-- eBay hands us the item id on both sources already (IncomingBestOffer.itemId,
-- ReturnSummary.itemId), so this stores it verbatim as the marketplace-side
-- string. It joins to listings.platform_listing_id (the eBay legacy item id).
-- Nullable: disputes are keyed to an order, not an item, and pre-existing rows
-- have no id to backfill — a null simply means "no listing link", and the
-- automation evaluator treats an absent fact as "does not fire".
--
-- NOT part of the unique dedup key (user_id, source_kind, external_id, status):
-- the event id already identifies the event, and widening the key would let the
-- same offer re-notify if eBay ever reported it under a different item id.

ALTER TABLE public.marketplace_event_notifications
  ADD COLUMN IF NOT EXISTS item_external_id text;

COMMENT ON COLUMN public.marketplace_event_notifications.item_external_id IS
  'US-2156: marketplace-side item id the event happened on (eBay legacy itemId); joins to listings.platform_listing_id. Null for events with no item (disputes) and for rows written before this column existed.';

-- The automation run asks one question: "which of this owner's items had an
-- event of kind K since T?" — so (user_id, source_kind, created_at desc) with
-- the item id along for the ride.
CREATE INDEX IF NOT EXISTS marketplace_event_notifications_item_idx
  ON public.marketplace_event_notifications (user_id, source_kind, created_at DESC)
  WHERE item_external_id IS NOT NULL;

insert into public.applied_migrations (version) values ('00508') on conflict do nothing;
