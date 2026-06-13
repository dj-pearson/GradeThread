-- US-845: make the Condition Index catalog data-driven and expand it 8 -> 50+.
--
-- The public Condition Index (US-621/622) previously drew its curated catalog
-- from a hardcoded CURATED_INDEX array in condition-index.ts — every new
-- brand/category entry required a deploy, capping our SEO/GEO authority surface.
-- This moves the catalog into a table so it can grow (and be curated by admins,
-- US-846) without shipping code. The refresh cron and the hub/curve readers now
-- source the seed list from here, falling back to CURATED_INDEX only when the
-- table is empty.
--
-- SECURITY MODEL (mirrors condition_price_curves 00098):
--   * RLS enabled; there are NO client policies, so anon/authenticated are
--     deny-all. The catalog is read + refreshed exclusively by the service-role
--     edge client (which bypasses RLS), and curated via admin endpoints (US-846)
--     that run service-role. Aggregate, non-tenant config data — no PII.
--
-- Each seed maps 1:1 onto a condition_price_curves row via the same identity the
-- engine derives from (brand|category_id|q), so backfilling the original 8 seeds
-- re-targets the existing curve rows — no orphaned curves. Idempotent via
-- IF NOT EXISTS + ON CONFLICT so a re-run on a partial apply is a no-op.

CREATE TABLE IF NOT EXISTS public.condition_index_seeds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Public URL slug: /condition-index/<slug>. One row per public Index entry.
  slug        text NOT NULL UNIQUE,
  -- Human label rendered on the hub + detail pages.
  label       text NOT NULL,
  -- eBay-facing identity the comps engine queries from.
  brand       text NOT NULL,
  category_id text NOT NULL,
  q           text,
  -- Disabled seeds are skipped by the refresh cron and not published.
  enabled     boolean NOT NULL DEFAULT true,
  -- Lower = processed/listed first. Ties broken by label.
  priority    integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.condition_index_seeds IS
  'US-845: data-driven catalog of curated Condition Index entries (brand/category/keyword). Service-role/admin only.';

-- The cron reads enabled seeds ordered by priority.
CREATE INDEX IF NOT EXISTS condition_index_seeds_enabled_priority_idx
  ON public.condition_index_seeds (priority, label)
  WHERE enabled;

-- updated_at maintained by the standard trigger (00001).
DROP TRIGGER IF EXISTS set_condition_index_seeds_updated_at
  ON public.condition_index_seeds;
CREATE TRIGGER set_condition_index_seeds_updated_at
  BEFORE UPDATE ON public.condition_index_seeds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Aggregate, non-tenant config. RLS on with zero client policies = deny-all to
-- anon/authenticated; the service-role edge bypasses RLS.
ALTER TABLE public.condition_index_seeds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.condition_index_seeds FROM anon, authenticated;

-- ── Seed catalog ────────────────────────────────────────────────────────────
-- Backfill the original 8 (priority 10-17) + 46 new high-traffic brand/category
-- entries across jackets, jeans, tees, fleece, knit, boots, dresses, footwear
-- and hoodies. ON CONFLICT (slug) DO NOTHING keeps this idempotent and lets
-- later admin edits (US-846) win over a re-seed.
INSERT INTO public.condition_index_seeds (slug, label, brand, category_id, q, priority) VALUES
  -- Original 8 (US-621 CURATED_INDEX backfill)
  ('patagonia-better-sweater', 'Patagonia Better Sweater', 'Patagonia', '11450', 'Better Sweater', 10),
  ('patagonia-jackets',        'Patagonia Jackets',        'Patagonia', '57988', 'jacket', 11),
  ('carhartt-jackets',         'Carhartt Jackets',         'Carhartt',  '57988', 'jacket', 12),
  ('levis-501-jeans',          'Levi''s 501 Jeans',        'Levi''s',   '11450', '501', 13),
  ('nike-vintage-tees',        'Nike Vintage Tees',        'Nike',      '15687', 'vintage tee', 14),
  ('the-north-face-fleece',    'The North Face Fleece',    'The North Face', '11450', 'fleece', 15),
  ('lululemon-leggings',       'Lululemon Leggings',       'Lululemon', '11450', 'align leggings', 16),
  ('ralph-lauren-polo',        'Ralph Lauren Polo Shirts', 'Ralph Lauren', '11450', 'polo', 17),

  -- Patagonia
  ('patagonia-nano-puff',      'Patagonia Nano Puff Jacket', 'Patagonia', '57988', 'Nano Puff', 20),
  ('patagonia-synchilla',      'Patagonia Synchilla Fleece', 'Patagonia', '11450', 'Synchilla', 21),
  ('patagonia-baggies',        'Patagonia Baggies Shorts',   'Patagonia', '11450', 'Baggies', 22),

  -- Arc'teryx
  ('arcteryx-beta-jacket',     'Arc''teryx Beta Jacket', 'Arc''teryx', '57988', 'Beta', 23),
  ('arcteryx-atom-hoody',      'Arc''teryx Atom Hoody',  'Arc''teryx', '57988', 'Atom', 24),
  ('arcteryx-gamma-pants',     'Arc''teryx Gamma Pants', 'Arc''teryx', '11450', 'Gamma', 25),

  -- Carhartt
  ('carhartt-detroit-jacket',  'Carhartt Detroit Jacket',     'Carhartt', '57988', 'Detroit', 26),
  ('carhartt-double-knee',     'Carhartt Double Knee Pants',  'Carhartt', '11450', 'double knee', 27),
  ('carhartt-beanie',          'Carhartt Watch Hat Beanie',   'Carhartt', '11450', 'watch hat', 28),
  ('carhartt-wip-jacket',      'Carhartt WIP Jacket',         'Carhartt WIP', '57988', 'jacket', 29),

  -- Levi's
  ('levis-505-jeans',          'Levi''s 505 Jeans',          'Levi''s', '11450', '505', 30),
  ('levis-511-jeans',          'Levi''s 511 Jeans',          'Levi''s', '11450', '511', 31),
  ('levis-trucker-jacket',     'Levi''s Trucker Jacket',     'Levi''s', '57988', 'trucker jacket', 32),
  ('levis-vintage-denim',      'Levi''s Vintage Denim Jacket','Levi''s', '57988', 'vintage denim', 33),

  -- Nike
  ('nike-tech-fleece',         'Nike Tech Fleece',     'Nike', '11450', 'tech fleece', 34),
  ('nike-windbreaker',         'Nike Windbreaker',     'Nike', '57988', 'windbreaker', 35),
  ('nike-air-force-1',         'Nike Air Force 1',     'Nike', '15709', 'air force 1', 36),
  ('nike-dunk',                'Nike Dunk',            'Nike', '15709', 'dunk', 37),

  -- Adidas
  ('adidas-track-jacket',      'Adidas Track Jacket',   'Adidas', '57988', 'track jacket', 38),
  ('adidas-trefoil-hoodie',    'Adidas Trefoil Hoodie', 'Adidas', '11450', 'trefoil hoodie', 39),
  ('adidas-samba',             'Adidas Samba',          'Adidas', '15709', 'samba', 40),
  ('adidas-gazelle',           'Adidas Gazelle',        'Adidas', '15709', 'gazelle', 41),

  -- Lululemon
  ('lululemon-abc-pants',      'Lululemon ABC Pants',    'Lululemon', '11450', 'ABC pant', 42),
  ('lululemon-define-jacket',  'Lululemon Define Jacket','Lululemon', '57988', 'Define', 43),
  ('lululemon-scuba-hoodie',   'Lululemon Scuba Hoodie', 'Lululemon', '11450', 'Scuba', 44),

  -- The North Face
  ('the-north-face-nuptse',    'The North Face Nuptse Jacket', 'The North Face', '57988', 'Nuptse', 45),
  ('the-north-face-denali',    'The North Face Denali Jacket', 'The North Face', '57988', 'Denali', 46),
  ('the-north-face-puffer',    'The North Face Puffer Jacket', 'The North Face', '57988', 'puffer', 47),

  -- Ralph Lauren
  ('ralph-lauren-oxford',      'Ralph Lauren Oxford Shirt', 'Ralph Lauren', '57990', 'oxford', 48),
  ('ralph-lauren-sweater',     'Ralph Lauren Knit Sweater', 'Ralph Lauren', '11484', 'sweater', 49),
  ('ralph-lauren-chinos',      'Polo Ralph Lauren Chinos',  'Ralph Lauren', '11450', 'chino', 50),

  -- Dr. Martens
  ('dr-martens-1460-boots',    'Dr. Martens 1460 Boots',    'Dr. Martens', '11498', '1460', 51),
  ('dr-martens-chelsea-boots', 'Dr. Martens Chelsea Boots', 'Dr. Martens', '11498', 'Chelsea', 52),

  -- High-traffic adjacents (hoodies, tees, knit, dresses, footwear)
  ('champion-reverse-weave',   'Champion Reverse Weave Hoodie', 'Champion', '11450', 'reverse weave', 53),
  ('supreme-box-logo-tee',     'Supreme Box Logo Tee',          'Supreme', '15687', 'box logo', 54),
  ('stussy-tee',               'Stussy Tee',                    'Stussy', '15687', 'tee', 55),
  ('tommy-hilfiger-jacket',    'Tommy Hilfiger Jacket',         'Tommy Hilfiger', '57988', 'jacket', 56),
  ('columbia-fleece',          'Columbia Fleece',               'Columbia', '11450', 'fleece', 57),
  ('uniqlo-ultra-light-down',  'Uniqlo Ultra Light Down',       'Uniqlo', '57988', 'ultra light down', 58),
  ('gap-denim-jacket',         'Gap Denim Jacket',              'Gap', '57988', 'denim jacket', 59),
  ('j-crew-sweater',           'J.Crew Sweater',                'J.Crew', '11484', 'sweater', 60),
  ('new-balance-990',          'New Balance 990',               'New Balance', '15709', '990', 61),
  ('timberland-boots',         'Timberland Boots',              'Timberland', '11498', 'boots', 62),
  ('free-people-dress',        'Free People Dress',             'Free People', '63861', 'dress', 63),
  ('reformation-dress',        'Reformation Dress',             'Reformation', '63861', 'dress', 64),
  ('zara-dress',               'Zara Dress',                    'Zara', '63861', 'dress', 65)
ON CONFLICT (slug) DO NOTHING;
