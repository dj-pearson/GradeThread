-- US-538: carry auto-defect annotations into listings.
--
-- Per-item OPT-IN for attaching AI defect-callout photos during AutoLister
-- generation. When enabled on a GRADED item, the AutoLister worker composites
-- the verified grade report's localized defects (bbox callouts + numbered
-- legend) onto the grading photos server-side and appends the results to
-- item_photos as 'defect' shots, so every publish path ships the disclosure
-- imagery with zero extra clicks. Default false — annotated photos never
-- appear unless the seller asked for them on that item.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS annotate_defect_photos boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.inventory_items.annotate_defect_photos IS
  'US-538: opt-in — AutoLister auto-attaches AI defect-callout photos composited from the verified grade report.';
