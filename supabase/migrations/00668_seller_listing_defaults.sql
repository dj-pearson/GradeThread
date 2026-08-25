-- US-2852: seller-level listing defaults — the composer's starting position.
--
-- Every new draft opened the composer with the SAME hard-coded starting state:
-- fixed price, Best Offer off, quantity 1, 7-day auction. That is one seller's
-- workflow imposed on all of them. A seller who runs Best Offer on everything
-- retyped it per item; a seller who never wants it had nothing to say so.
--
-- Modelled column-for-column on 00432 (Promoted Listings defaults), which
-- already answers this exact shape of question for ad rates: per-seller default
-- on the user's own row, per-listing value still wins. RLS scopes public.users
-- to the authenticated user and guard_users_protected_columns (00076) does not
-- list these columns, so a seller self-edits them from Settings.
--
-- NULL means "no opinion, use the platform default" for every column here, so a
-- seller who never visits Settings keeps exactly today's behaviour. The two
-- booleans are NOT NULL DEFAULT false because off IS the platform default for
-- both and a tri-state would buy nothing.
--
--   default_listing_format          text  fixed_price | auction; null -> fixed_price
--   default_auction_duration        text  DAYS_1|3|5|7|10; null -> DAYS_7
--   default_best_offer_enabled      bool  seed new fixed-price drafts with Best Offer on
--   default_best_offer_on_auction   bool  also seed it on auction drafts
--   default_best_offer_accept_pct   num   auto-accept at this % of price; null -> blank
--   default_best_offer_decline_pct  num   auto-decline below this % of price; null -> blank
--   default_listing_quantity        int   new fixed-price draft quantity; null -> 1
--
-- The Best Offer thresholds are PERCENTAGES here and cents on listings. That is
-- deliberate: a default has to survive being applied to a $12 tee and a $600
-- jacket, and US-2405 removed the last stored absolute default precisely because
-- a cents figure outlived the price it was derived from. The composer converts
-- pct -> cents against the resolved price at seed time and then the cents column
-- owns it, so nothing re-derives later.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + guarded constraints); safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_listing_format text;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_auction_duration text;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_best_offer_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_best_offer_on_auction boolean NOT NULL DEFAULT false;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_best_offer_accept_pct numeric;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_best_offer_decline_pct numeric;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS default_listing_quantity integer;

COMMENT ON COLUMN public.users.default_listing_format IS
  'FlipDesk: seller default listing format for a NEW draft (fixed_price|auction). Null -> fixed_price. A saved listing''s own format always wins.';
COMMENT ON COLUMN public.users.default_auction_duration IS
  'FlipDesk: seller default auction duration for a NEW auction draft (DAYS_1|DAYS_3|DAYS_5|DAYS_7|DAYS_10). Null -> DAYS_7.';
COMMENT ON COLUMN public.users.default_best_offer_enabled IS
  'FlipDesk: when true, a NEW fixed-price draft opens with Best Offer already on. Default false.';
COMMENT ON COLUMN public.users.default_best_offer_on_auction IS
  'FlipDesk: when true, a NEW auction draft also opens with Best Offer on. Separate from the fixed-price flag because eBay treats Best Offer on an auction as a different product decision (it ends the auction early).';
COMMENT ON COLUMN public.users.default_best_offer_accept_pct IS
  'FlipDesk: seller default Best Offer auto-accept threshold as a PERCENT of the listing price (1-99). Converted to best_offer_auto_accept_cents at seed time. Null -> leave blank.';
COMMENT ON COLUMN public.users.default_best_offer_decline_pct IS
  'FlipDesk: seller default Best Offer auto-decline threshold as a PERCENT of the listing price (1-99). Converted to best_offer_auto_decline_cents at seed time. Null -> leave blank.';
COMMENT ON COLUMN public.users.default_listing_quantity IS
  'FlipDesk: seller default quantity for a NEW fixed-price draft. Null -> 1. Auctions and variation matrices override it (resolveQuantity).';

-- Value guards. Written as guarded DO blocks rather than bare ADD CONSTRAINT so
-- the file re-runs cleanly: ADD CONSTRAINT has no IF NOT EXISTS on this version.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_default_listing_format_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_default_listing_format_check
      CHECK (default_listing_format IS NULL
             OR default_listing_format IN ('fixed_price', 'auction'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_default_auction_duration_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_default_auction_duration_check
      CHECK (default_auction_duration IS NULL
             OR default_auction_duration IN
                ('DAYS_1', 'DAYS_3', 'DAYS_5', 'DAYS_7', 'DAYS_10'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_default_best_offer_pct_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_default_best_offer_pct_check
      CHECK (
        (default_best_offer_accept_pct IS NULL
         OR (default_best_offer_accept_pct > 0 AND default_best_offer_accept_pct < 100))
        AND
        (default_best_offer_decline_pct IS NULL
         OR (default_best_offer_decline_pct > 0 AND default_best_offer_decline_pct < 100))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_default_listing_quantity_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_default_listing_quantity_check
      CHECK (default_listing_quantity IS NULL OR default_listing_quantity > 0);
  END IF;
END $$;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00668') ON CONFLICT DO NOTHING;
