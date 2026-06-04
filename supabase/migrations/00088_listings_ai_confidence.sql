-- US-541: persist + act on the AI's confidence for an AutoLister-generated
-- draft, so low-confidence listings can be routed to review instead of
-- publishing identically to high-confidence ones.
--
-- generateListing already produces an overall confidence (0..1) and the
-- aspect-refine pass (extractEbayAspects) produces a per-aspect confidence —
-- both were previously DISCARDED. We now store them and a derived needs_review
-- flag the queue/bulk-edit surfaces use to triage.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(3,2),
  ADD COLUMN IF NOT EXISTS ai_field_confidence jsonb,
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.listings.ai_confidence IS
  'US-541: overall AI confidence (0..1) for an AutoLister-generated draft; null for non-AI listings.';
COMMENT ON COLUMN public.listings.ai_field_confidence IS
  'US-541: per-aspect confidence map { aspectName: 0..1 } from the aspect-refine pass.';
COMMENT ON COLUMN public.listings.needs_review IS
  'US-541: true when the AI was unsure (low overall or low per-aspect confidence) so the queue can flag it for a human look before publish.';

-- Supports the triage view (US-550): a batch's drafts that need a look.
CREATE INDEX IF NOT EXISTS idx_listings_batch_needs_review
  ON public.listings (batch_id)
  WHERE needs_review = true;
