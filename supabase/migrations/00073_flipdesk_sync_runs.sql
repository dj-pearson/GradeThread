-- Per-run history of marketplace syncs (eBay "pull") so the Reconciliation
-- page can show what each sync did: how many listings were pulled/matched,
-- how many sales were created/updated, fee-enrichment count, and any errors.
--
-- The pull (services/edge-functions/src/routes/flipdesk-ebay.ts → doListingsPull)
-- already computes all of these counts but, because it runs fire-and-forget in
-- the background (HTTP 202), previously discarded them to the container log.
-- It now writes one row here when each run finishes (success | partial | failed)
-- so the stats survive and are queryable per tenant.

CREATE TABLE IF NOT EXISTS public.flipdesk_sync_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owner of the run. Marketplace connections live on the workspace owner, so
  -- this is the workspaceOwnerId the edge service syncs on behalf of.
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  marketplace text NOT NULL DEFAULT 'ebay',

  -- running (reserved) | success (no errors) | partial (completed w/ errors) | failed
  status      text NOT NULL DEFAULT 'success',

  -- Listings pass.
  listings_total     integer NOT NULL DEFAULT 0,  -- offers fetched from eBay
  listings_matched   integer NOT NULL DEFAULT 0,  -- linked to a FlipDesk item by SKU
  listings_unmatched integer NOT NULL DEFAULT 0,  -- snapshotted for reconciliation
  listings_skipped   integer NOT NULL DEFAULT 0,  -- drafts / no listingId
  legacy_matched     integer NOT NULL DEFAULT 0,  -- Trading-API fallback pass
  legacy_unmatched   integer NOT NULL DEFAULT 0,
  legacy_duplicates  integer NOT NULL DEFAULT 0,

  -- Orders / sales pass.
  sales_new      integer NOT NULL DEFAULT 0,
  sales_updated  integer NOT NULL DEFAULT 0,
  sales_skipped  integer NOT NULL DEFAULT 0,  -- unpaid / no SKU match
  sales_enriched integer NOT NULL DEFAULT 0,  -- fees + payout written via Finances API

  error_count integer NOT NULL DEFAULT 0,
  errors      jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- capped list of error strings

  since       timestamptz,            -- incremental window start (null = first/full sync)
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- The history feed: a user's runs, freshest first.
CREATE INDEX IF NOT EXISTS idx_flipdesk_sync_runs_user_started
  ON public.flipdesk_sync_runs(user_id, started_at DESC);

ALTER TABLE public.flipdesk_sync_runs ENABLE ROW LEVEL SECURITY;

-- Users can read their own sync runs. Inserts come from the service-role edge
-- service, which scopes every write to the owning user_id.
CREATE POLICY "Users can view own sync runs"
  ON public.flipdesk_sync_runs FOR SELECT
  USING (auth.uid() = user_id);
