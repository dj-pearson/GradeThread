-- 3-way reconciliation: FlipDesk ↔ eBay ↔ Google Sheets (US-148).
--
-- After each eBay listings pull (US-122) and each Google Sheet merge (US-147),
-- the edge service compares the external source's per-listing values against
-- FlipDesk's listing row and records any disagreement here. One OPEN row per
-- (listing, field); the Cross-source tab on /dashboard/flipdesk/reconciliation
-- lets the user pick the winning source per field (or in bulk), which applies
-- the value to the DB and persists the choice in listings.source_of_truth.

CREATE TABLE IF NOT EXISTS public.flipdesk_sync_conflicts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  listing_id     uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  field_name     text NOT NULL CHECK (field_name IN ('price', 'quantity', 'listing_status', 'title')),
  -- Values are normalized strings captured at detection time. flipdesk_value is
  -- the value FlipDesk held BEFORE any eBay-wins overwrite, so "restore the
  -- FlipDesk value" stays possible even after the pull has applied eBay's.
  flipdesk_value text,
  ebay_value     text,
  sheets_value   text,
  -- Auto-flag rule: 'mark_ended_in_flipdesk' when eBay reports the listing
  -- ended but FlipDesk still has it active.
  suggested_action text,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  -- Winning source the user picked ('flipdesk' | 'ebay' | 'sheets'), or
  -- 'auto_converged' when the external source came back to FlipDesk's value.
  resolution     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Detection upserts into the single open row per listing+field.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_conflicts_open_unique
  ON public.flipdesk_sync_conflicts (listing_id, field_name)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user_open
  ON public.flipdesk_sync_conflicts (user_id)
  WHERE resolved_at IS NULL;

CREATE TRIGGER set_flipdesk_sync_conflicts_updated_at
  BEFORE UPDATE ON public.flipdesk_sync_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_sync_conflicts ENABLE ROW LEVEL SECURITY;
-- No policies: rows are read/written only via the service-role edge client,
-- with tenant scoping enforced in code (US-268).

-- Per-field source-of-truth choices, e.g. {"price": "flipdesk"}. A field keyed
-- to a source other than 'ebay' is protected from the eBay pull's default
-- eBay-wins overwrite, and decided fields are excluded from re-flagging.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS source_of_truth jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Mirror of eBay's availableQuantity; NULL until a sync first observes it
-- (quantity disagreements are only flagged once FlipDesk has an opinion).
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS quantity integer;

-- Email alert threshold: when a sync pushes the user's OPEN conflict count
-- from below to at-or-above this number, send one email. NULL disables.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS sync_conflict_email_threshold integer DEFAULT 10;
