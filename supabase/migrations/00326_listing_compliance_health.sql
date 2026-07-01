-- US-1422: persist per-listing eBay compliance (Listing Health) so the pipeline
-- can flag listings with policy / item-specifics violations without a live Sell
-- Compliance API call on every render. Populated by the /compliance/sync edge
-- job from getListingViolationsSummary/getListingViolations.
--
-- On public.listings, which already carries the denormalized owning tenant
-- (user_id) + RLS, so these inherit tenant isolation with no new policy.
--   compliance_violation_count  # of open violations for this listing (0 = clean)
--   compliance_types            distinct compliance types (ASPECTS_ADOPTION, …)
--   compliance_checked_at       when the last sync evaluated this listing
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); safe to re-run on any prior state.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS compliance_violation_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS compliance_types text[];

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS compliance_checked_at timestamptz;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00326') ON CONFLICT DO NOTHING;
