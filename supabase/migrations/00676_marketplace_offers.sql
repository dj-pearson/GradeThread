-- US-2939: one local row per offer, in either direction.
--
-- Best offers were fetched live from eBay's Trading API and never stored, so
-- three things were impossible: seeing what a buyer has already offered, knowing
-- what our own counters convert at, and putting a margin or an expiry countdown
-- on a row without a second round trip.
--
-- `direction` is what makes one table serve all three flows. An offer RECEIVED
-- from a buyer, a COUNTER we sent back, and an offer we SENT to interested
-- buyers are the same shape and different events, and collapsing them would let
-- our own counter be read as a buyer's bid.

CREATE TABLE IF NOT EXISTS public.marketplace_offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform              text NOT NULL DEFAULT 'ebay',
  external_offer_id     text NOT NULL,
  direction             text NOT NULL,
  item_external_id      text,
  inventory_item_id     uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  listing_id            uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  buyer_username        text,
  amount_cents          integer,
  currency              text,
  -- What the listing was asking when the offer landed. Snapshotted rather than
  -- read back from the listing, because a later reprice would otherwise rewrite
  -- history: an offer at 70% of a $24 ask must not become an offer at 6% of a
  -- $298 one the day the seller raises the price.
  list_price_cents      integer,
  state                 text,
  expires_at            timestamptz,
  responded_at          timestamptz,
  response              text,
  response_amount_cents integer,
  -- The automation rule that answered it, when one did. Null means a human.
  rule_id               uuid REFERENCES public.flipdesk_automation_rules(id) ON DELETE SET NULL,
  raw                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_offers_direction_check CHECK (
    direction IN ('received', 'counter_sent', 'offer_sent')
  ),
  UNIQUE (user_id, platform, external_offer_id, direction)
);

-- The offers page reads one seller's live offers soonest-expiry first.
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_user_expiry
  ON public.marketplace_offers(user_id, expires_at NULLS LAST)
  WHERE responded_at IS NULL;

-- Buyer memory ("this buyer has offered twice before") and the per-item history.
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_user_buyer
  ON public.marketplace_offers(user_id, buyer_username)
  WHERE buyer_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_offers_user_item
  ON public.marketplace_offers(user_id, item_external_id)
  WHERE item_external_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_marketplace_offers_updated_at ON public.marketplace_offers;
CREATE TRIGGER set_marketplace_offers_updated_at
  BEFORE UPDATE ON public.marketplace_offers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: a seller reads their own offers and nothing else. The edge writes through
-- the service-role client, which bypasses this, so the edge ALSO filters on
-- user_id explicitly (US-268) — this policy is the second lock, not the only one.
ALTER TABLE public.marketplace_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own marketplace offers" ON public.marketplace_offers;
CREATE POLICY "own marketplace offers" ON public.marketplace_offers
  -- US-1927: the wrapped INITPLAN form, so the session-user lookup hoists to a
  -- single initplan instead of being re-evaluated once per row.
  FOR SELECT USING ((select auth.uid()) = user_id);

COMMENT ON TABLE public.marketplace_offers IS
  'US-2939: local record of every marketplace offer in either direction — received '
  'from a buyer, countered by the seller, or sent to interested buyers. eBay remains '
  'the source of truth for state; this exists so counter history, buyer memory and '
  'offer analytics can be read without a live call. list_price_cents is snapshotted at '
  'the time of the offer so a later reprice cannot rewrite what a discount was worth.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00676') ON CONFLICT DO NOTHING;
