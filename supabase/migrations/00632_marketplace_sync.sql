-- US-2697: sold-sync storage for the no-API marketplaces.
--
-- The Lister publishes to Poshmark/Mercari/Grailed/Vinted and nothing comes
-- back, so cross-listing-sale.ts never fires for those channels and the same
-- garment can sell twice. These three tables are what the browser extension's
-- observations land in.
--
-- WHAT IS DELIBERATELY NOT HERE: any free-form payload column. The extension
-- reports a listing URL, a title, a price and a date; a Poshmark order page
-- also carries the BUYER's name and shipping address, and the way to guarantee
-- those never land is to have no column that could hold them. There is no jsonb
-- here for a CHECK constraint to police, which is the point -- the column list
-- itself is the constraint, and marketplace-sync-columns_test.ts pins it.
--
-- Design of record:
-- docs/superpowers/specs/2026-08-19-extension-sold-sync-design.md

-- ── the dedupe ledger ──────────────────────────────────────────────────────
-- The same Sold row is re-read on every poll. This is what makes the second
-- sighting free rather than a second sale.
CREATE TABLE IF NOT EXISTS public.marketplace_sync_observations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  -- The platform's own order reference where it prints one, else the listing
  -- URL plus the sold date. Built by dedupeKeyFor() in lib/marketplace-observations.ts.
  dedupe_key  text NOT NULL,
  listing_id  uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  sold_at     timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sync_observations_key_uniq
  ON public.marketplace_sync_observations (user_id, platform, dedupe_key);

-- ── the review queue ───────────────────────────────────────────────────────
-- Everything the planner refused to act on by itself: a probable match, an
-- unexplained disappearance, a count gap, a tripped circuit breaker.
CREATE TABLE IF NOT EXISTS public.marketplace_sync_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform          text NOT NULL,
  reason            text NOT NULL CHECK (reason IN (
                      'probable_match', 'unexplained_absence', 'count_gap', 'circuit_breaker'
                    )),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  listing_id        uuid REFERENCES public.listings(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  listing_url       text,
  title             text,
  sold_price_cents  integer CHECK (sold_price_cents IS NULL OR sold_price_cents >= 0),
  sold_at           timestamptz,
  dedupe_key        text,
  -- count_gap: live listings that vanished with no sale explaining them.
  unexplained       integer,
  -- circuit_breaker: how many sales the batch claimed, and the cap it blew.
  claimed           integer,
  cap               integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_sync_reviews_open_idx
  ON public.marketplace_sync_reviews (user_id, platform, status);

-- One open row per (tenant, platform, reason, listing). A poll every 30 minutes
-- re-observes the same unexplained absence forever, and without this the seller
-- opens the queue to forty copies of one problem.
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sync_reviews_open_uniq
  ON public.marketplace_sync_reviews (user_id, platform, reason, listing_id)
  WHERE status = 'open' AND listing_id IS NOT NULL;

-- ── per-channel sync state ─────────────────────────────────────────────────
-- What the popup and the Marketplaces page both render. `status = failing` is
-- the selector-regression signal: a complete closet read that returned nothing
-- while listings are believed live.
CREATE TABLE IF NOT EXISTS public.marketplace_sync_state (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform       text NOT NULL,
  status         text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failing', 'not_signed_in')),
  failure_reason text,
  listings_seen  integer,
  last_ok_at     timestamptz,
  last_read_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sync_state_uniq
  ON public.marketplace_sync_state (user_id, platform);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- A seller reads their own sync rows and nothing else. The edge writes through
-- the service-role client, which bypasses this, so the edge ALSO filters on
-- user_id explicitly (US-268). These policies are the second lock, not the only
-- one. The wrapped INITPLAN form (US-1927) hoists the session lookup out of the
-- per-row path.
ALTER TABLE public.marketplace_sync_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own sync observations" ON public.marketplace_sync_observations;
CREATE POLICY "own sync observations" ON public.marketplace_sync_observations
  FOR SELECT USING ((select auth.uid()) = user_id);

ALTER TABLE public.marketplace_sync_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own sync reviews" ON public.marketplace_sync_reviews;
CREATE POLICY "own sync reviews" ON public.marketplace_sync_reviews
  FOR SELECT USING ((select auth.uid()) = user_id);

ALTER TABLE public.marketplace_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own sync state" ON public.marketplace_sync_state;
CREATE POLICY "own sync state" ON public.marketplace_sync_state
  FOR SELECT USING ((select auth.uid()) = user_id);

COMMENT ON TABLE public.marketplace_sync_observations IS
  'US-2697: dedupe ledger for sold-sync. One row per sale the extension has already '
  'reported, so re-reading the same Sold page is a no-op rather than a second sale.';
COMMENT ON TABLE public.marketplace_sync_reviews IS
  'US-2697: what the observation planner refused to act on alone. Carries no buyer '
  'identity by construction -- there is no column for one.';
COMMENT ON TABLE public.marketplace_sync_state IS
  'US-2697: per-tenant per-platform sync health. status=failing means a complete '
  'closet read returned nothing while listings are believed live, which is a '
  'selector regression and not a seller who sold out.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00632') on conflict do nothing;
