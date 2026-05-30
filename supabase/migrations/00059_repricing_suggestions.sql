-- Condition-aware dynamic repricing — persisted nudges per active listing.
--
-- The repricing engine fetches CONDITION-MATCHED comps (eBay conditionId
-- derived from the item's grade) and positions the suggested price within the
-- comp distribution by grade — so a grade-9 isn't priced like a grade-6. The
-- scan job (on-demand or cron) writes one current suggestion per listing here;
-- the FlipDesk Repricing surface reads them and the seller applies/dismisses.

CREATE TABLE IF NOT EXISTS public.repricing_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalized owner for cheap tenant-scoped reads + RLS (listings/items
  -- have no user_id column; we copy the owning user's id here).
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  listing_id        uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,

  current_price_cents   integer NOT NULL,
  suggested_price_cents integer NOT NULL,
  comp_median_cents     integer,
  comp_count            integer NOT NULL DEFAULT 0,
  condition_id          text,            -- eBay conditionId the comps were matched on

  -- UNDERPRICED | OVERPRICED | STALE | OK | NO_COMPS
  reason_code       text NOT NULL,
  message           text NOT NULL,
  confidence        numeric(3,2) NOT NULL DEFAULT 0.5,

  -- pending | applied | dismissed
  status            text NOT NULL DEFAULT 'pending',
  applied_at        timestamptz,
  dismissed_at      timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One current suggestion per listing — the scan upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_repricing_suggestions_listing
  ON public.repricing_suggestions(listing_id);

-- The nudges feed: a user's pending suggestions, freshest first.
CREATE INDEX IF NOT EXISTS idx_repricing_suggestions_user_status
  ON public.repricing_suggestions(user_id, status, updated_at DESC);

CREATE TRIGGER set_repricing_suggestions_updated_at
  BEFORE UPDATE ON public.repricing_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.repricing_suggestions ENABLE ROW LEVEL SECURITY;

-- Users (and their workspace members, via the same additive pattern used
-- elsewhere) can read their own suggestions. Writes go through the
-- service-role edge service, which scopes every query to the owner.
CREATE POLICY "Users can view own repricing suggestions"
  ON public.repricing_suggestions FOR SELECT
  USING (auth.uid() = user_id);
