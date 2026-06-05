-- US-621: public Condition Index — give curated curves a clean public slug.
--
-- condition_price_curves (00098) caches a curve per item_key for ANY item the
-- platform values (ScoutAI/Snap on-demand). The public Condition Index only
-- shows a CURATED, high-data subset, each with a clean URL slug
-- (/condition-index/<slug>) and a human label. A null slug = a private/on-demand
-- curve that is NOT part of the public Index (so thin one-off curves never leak
-- into the SEO surface — US-622).

ALTER TABLE public.condition_price_curves
  ADD COLUMN IF NOT EXISTS slug  text,
  ADD COLUMN IF NOT EXISTS label text;

CREATE UNIQUE INDEX IF NOT EXISTS condition_price_curves_slug_key
  ON public.condition_price_curves (slug)
  WHERE slug IS NOT NULL;
