-- US-826: partial eBay-prep recovery flag.
--
-- The one-call listing prep in flipdesk-ai.ts (/api/flipdesk/ai/extract) resolves
-- an eBay leaf category and then fills that category's item-specifics with a
-- second model pass. When the second pass cannot run — the monthly AI budget is
-- exhausted, or the aspect extraction errors — we still persist the resolved
-- ebay_category_id (half the win), but the aspects are left empty.
--
-- This flag marks exactly those items: category resolved, aspects NOT filled.
-- The specifics editor / publish-prep path picks the flag up and runs the
-- DETERMINISTIC, NO-AI refill (deriveAspectsFromItem + getCategoryAspects,
-- US-824) on next open, then clears the flag. We never re-invoke AI to recover a
-- partial prep — the aspects are gap-filled from the item's own columns +
-- US-821 canonical attributes instead.
--
-- Idempotent (US-1108): IF NOT EXISTS column + self-record footer.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS ebay_aspects_refill_needed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.inventory_items.ebay_aspects_refill_needed IS
  'US-826: true when one-call eBay prep resolved ebay_category_id but could not fill ebay_aspects (AI budget exhausted or aspect extraction failed). The specifics editor / publish-prep deterministically refills aspects (NO AI) on next open and clears this.';

-- Partial index: only the handful of items awaiting deterministic refill are
-- indexed, so a "needs refill" sweep stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_inventory_items_aspects_refill_needed
  ON public.inventory_items (user_id)
  WHERE ebay_aspects_refill_needed;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00299')
ON CONFLICT (version) DO NOTHING;
