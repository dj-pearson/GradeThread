-- US-722: per-platform category taxonomy mapping (seeded + admin-extensible + AI cache).
--
-- A shared cache/override table that maps a GradeThread garment type to each
-- no-API marketplace's category. Mirrors ebay_category_aspects (00030): shared
-- across ALL users so a single warm row serves everyone and repeat items cost
-- ~0 AI. Rows originate from one of three sources:
--   seed  — deterministic mapping shipped in code (resolveSeededCategory)
--   ai    — Claude-suggested when a garment type isn't seeded (needs_confirmation)
--   admin — an operator override/extension via /api/admin/category-map
--
-- eBay (Taxonomy API resolution) and Shopify (free-form category) are
-- intentionally NOT stored here — they don't use the no-API curated map.

CREATE TABLE IF NOT EXISTS public.marketplace_category_map (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform            public.listing_platform NOT NULL,
  -- Canonical GradeThread garment key: tops|bottoms|outerwear|dresses|footwear|accessories.
  gradethread_garment text NOT NULL,
  -- The resolved platform-native category (a leaf/path the seller confirms).
  platform_category   text NOT NULL,
  -- Optional department/gender (Men/Women/Kids) when the platform splits on it.
  department          text,
  source              text NOT NULL DEFAULT 'seed'
                        CHECK (source IN ('seed', 'ai', 'admin')),
  -- AI confidence 0..1 for source='ai'; null for seed/admin.
  confidence          numeric,
  -- True until a human (seller or admin) confirms an AI suggestion.
  needs_confirmation  boolean NOT NULL DEFAULT false,
  created_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, gradethread_garment)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_category_map_platform
  ON public.marketplace_category_map(platform);

-- Shared across all users — one warm cache entry benefits every seller. Reads
-- allowed to any authenticated user; writes go through the service-role edge
-- client only (no client INSERT/UPDATE/DELETE policies).
ALTER TABLE public.marketplace_category_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read marketplace category map"
  ON public.marketplace_category_map FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE TRIGGER set_marketplace_category_map_updated_at
  BEFORE UPDATE ON public.marketplace_category_map
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Seed the deterministic map (mirrors marketplace-category.ts SEED) ──
-- These are leaf suggestions; the seller confirms the department in the kit.
INSERT INTO public.marketplace_category_map
  (platform, gradethread_garment, platform_category, source)
VALUES
  ('poshmark', 'tops',        'Tops',                'seed'),
  ('poshmark', 'bottoms',     'Pants & Jumpsuits',   'seed'),
  ('poshmark', 'outerwear',   'Jackets & Coats',     'seed'),
  ('poshmark', 'dresses',     'Dresses',             'seed'),
  ('poshmark', 'footwear',    'Shoes',               'seed'),
  ('poshmark', 'accessories', 'Accessories',         'seed'),
  ('mercari',  'tops',        'Tops & blouses',      'seed'),
  ('mercari',  'bottoms',     'Pants',               'seed'),
  ('mercari',  'outerwear',   'Coats & jackets',     'seed'),
  ('mercari',  'dresses',     'Dresses',             'seed'),
  ('mercari',  'footwear',    'Shoes',               'seed'),
  ('mercari',  'accessories', 'Accessories',         'seed'),
  ('depop',    'tops',        'Tops',                'seed'),
  ('depop',    'bottoms',     'Bottoms',             'seed'),
  ('depop',    'outerwear',   'Outerwear & Jackets', 'seed'),
  ('depop',    'dresses',     'Dresses',             'seed'),
  ('depop',    'footwear',    'Shoes',               'seed'),
  ('depop',    'accessories', 'Accessories',         'seed'),
  ('grailed',  'tops',        'Tops',                'seed'),
  ('grailed',  'bottoms',     'Bottoms',             'seed'),
  ('grailed',  'outerwear',   'Outerwear',           'seed'),
  ('grailed',  'dresses',     'Dresses',             'seed'),
  ('grailed',  'footwear',    'Footwear',            'seed'),
  ('grailed',  'accessories', 'Accessories',         'seed')
ON CONFLICT (platform, gradethread_garment) DO NOTHING;
