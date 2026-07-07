-- US-1710: Brand & Style Knowledge Base — schema foundation.
--
-- Garment identification (AutoLister: ai-extract.ts -> ai-listing.ts) and, in
-- phase 2, grading baselines fail most on BRAND + STYLE + SIZE when the main
-- care tag is cut off (the motivating case: Lululemon, whose style number and
-- hidden pocket size-dot encode identity independently of the size tag). Today
-- that knowledge lives only in the model's memory plus two hardcoded TS seeds
-- (brand-normalize.ts BRAND_ALIASES, sizing-charts.ts SIZING_CHARTS).
--
-- These five tables make that knowledge a DB-backed, retrievable, human-
-- verifiable knowledge base. The resolver (US-1711) reads them DB-first and
-- falls back to the in-code seeds, mirroring resolveActivePrompt +
-- ai_prompt_versions (00050) and the garment_baselines pattern (00341).
--
-- GLOBAL REFERENCE / operator tables: brand facts only, NO tenant data and no
-- owner column. RLS is enabled with ZERO policies (deny-all); the edge service-
-- role client (which bypasses RLS) reads the packs and the admin routes write
-- them. Registered in SERVICE_ROLE_ONLY (rls-guard_test.ts). Every fact-bearing
-- row carries source_url + confidence + verified + updated_by so a pack can be
-- audited and human-verified (US-1715 admin UI, US-1716 seeding harness).
--
-- brand_key = the normalized match key (lowercase, [a-z0-9] only), the same key
-- brandKey() computes in brand-normalize.ts. Child tables reference it as a soft
-- (indexed, not FK-enforced) link so a chart/style can be seeded before its
-- brand_knowledge row exists — the KB is designed to grow piecemeal.

-- ── brand_knowledge: one row per canonical brand ────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_knowledge (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key             text NOT NULL UNIQUE,
  canonical_brand       text NOT NULL,
  -- normalized alias/misspelling keys that resolve to this brand
  aliases               text[] NOT NULL DEFAULT '{}',
  -- e.g. {denim, workwear}; what the brand is known for
  category_focus        text[] NOT NULL DEFAULT '{}',
  -- RN/CA/registered-number ranges (as text; ranges + singletons)
  registered_numbers    text[] NOT NULL DEFAULT '{}',
  -- [{era, years, description}] — tag/label generations for dating
  tag_eras              jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- country-of-manufacture patterns / notes
  country_patterns      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{tell, detail}] — authentication / counterfeit tells (informational)
  authentication_tells  jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes                 text,
  source_url            text,
  confidence            numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  verified              boolean NOT NULL DEFAULT false,
  updated_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── brand_styles: named styles/models per brand ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_styles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key           text NOT NULL,
  style_name          text NOT NULL,
  aliases             text[] NOT NULL DEFAULT '{}',
  product_line        text,
  -- NOT NULL DEFAULT '' so the unique key is plain columns (PostgREST upsert
  -- onConflict can't target an expression index — the garment_baselines lesson).
  department          text NOT NULL DEFAULT '',   -- Men | Women | Unisex | Kids | ''
  category            text,                 -- pant | legging | jacket | ...
  -- the disambiguating description (silhouette, pockets, hardware, stitching)
  visual_fingerprint  text,
  fabric_tech         text[] NOT NULL DEFAULT '{}',
  era                 text,                 -- years / generation
  msrp_band           text,
  keywords            text[] NOT NULL DEFAULT '{}',
  source_url          text,
  confidence          numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  verified            boolean NOT NULL DEFAULT false,
  updated_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_styles_key_idx
  ON public.brand_styles (brand_key, style_name, department);
CREATE INDEX IF NOT EXISTS brand_styles_brand_idx
  ON public.brand_styles (brand_key);

-- ── brand_style_codes: deterministic tag-code decoder specs (US-1712) ───────
CREATE TABLE IF NOT EXISTS public.brand_style_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key         text NOT NULL,
  -- style_number | size_dot | date_code | serial | lot_number | article_number
  decoder_kind      text NOT NULL,
  description       text,
  -- regex or human-readable format spec the generic parser applies
  pattern           text,
  -- how to map a matched code into {brand, style, size, colorway, season}
  extraction_rules  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{code, expected}] fixtures for the golden harness (US-1716)
  examples          jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_url        text,
  confidence        numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  verified          boolean NOT NULL DEFAULT false,
  updated_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_style_codes_key_idx
  ON public.brand_style_codes (brand_key, decoder_kind);

-- ── brand_colorways: proprietary named colors per brand ─────────────────────
CREATE TABLE IF NOT EXISTS public.brand_colorways (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key     text NOT NULL,
  color_name    text NOT NULL,
  aliases       text[] NOT NULL DEFAULT '{}',
  hex           text,
  years         text,
  source_url    text,
  confidence    numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  verified      boolean NOT NULL DEFAULT false,
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_colorways_key_idx
  ON public.brand_colorways (brand_key, color_name);

-- ── brand_size_charts: mirrors sizing-charts.ts SizingChart 1:1 ─────────────
CREATE TABLE IF NOT EXISTS public.brand_size_charts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key       text NOT NULL,
  brand_label     text NOT NULL,           -- display name, e.g. "Lululemon"
  brand_match     text[] NOT NULL DEFAULT '{}',   -- lowercased match substrings
  department      text NOT NULL,
  garment         text NOT NULL,
  category_match  text[] NOT NULL DEFAULT '{}',
  -- [{size, measurements:{name:value-in-inches}}]
  rows            jsonb NOT NULL,
  note            text,
  source_url      text,
  confidence      numeric(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  verified        boolean NOT NULL DEFAULT false,
  updated_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS brand_size_charts_key_idx
  ON public.brand_size_charts (brand_key, department, garment);

-- ── RLS: deny-all on all five (global reference; service-role only) ──────────
ALTER TABLE public.brand_knowledge   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_styles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_style_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_colorways   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_size_charts ENABLE ROW LEVEL SECURITY;

-- ── updated_at triggers (shared helper used by every table) ─────────────────
DROP TRIGGER IF EXISTS set_brand_knowledge_updated_at ON public.brand_knowledge;
CREATE TRIGGER set_brand_knowledge_updated_at
  BEFORE UPDATE ON public.brand_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_brand_styles_updated_at ON public.brand_styles;
CREATE TRIGGER set_brand_styles_updated_at
  BEFORE UPDATE ON public.brand_styles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_brand_style_codes_updated_at ON public.brand_style_codes;
CREATE TRIGGER set_brand_style_codes_updated_at
  BEFORE UPDATE ON public.brand_style_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_brand_colorways_updated_at ON public.brand_colorways;
CREATE TRIGGER set_brand_colorways_updated_at
  BEFORE UPDATE ON public.brand_colorways
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_brand_size_charts_updated_at ON public.brand_size_charts;
CREATE TRIGGER set_brand_size_charts_updated_at
  BEFORE UPDATE ON public.brand_size_charts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Seed brand_knowledge from BRAND_ALIASES (brand-normalize.ts, US-544) ──
-- Aliases are the normalized match-keys; the resolver (US-1711) falls back
-- to the in-code table when a brand is absent here.
insert into public.brand_knowledge (brand_key, canonical_brand, aliases, source_url, confidence, verified, updated_by) values
  ('levis', 'Levi''s', ARRAY['levi','levis','levistrauss','levistraussco']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('wrangler', 'Wrangler', ARRAY['wrangler']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('lee', 'Lee', ARRAY['lee']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('dickies', 'Dickies', ARRAY['dickies']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('carhartt', 'Carhartt', ARRAY['carhartt']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('thenorthface', 'The North Face', ARRAY['northface','thenorthface','tnf']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('patagonia', 'Patagonia', ARRAY['patagonia']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('columbia', 'Columbia', ARRAY['columbia','columbiasportswear']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('llbean', 'L.L.Bean', ARRAY['llbean']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('eddiebauer', 'Eddie Bauer', ARRAY['eddiebauer']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('marmot', 'Marmot', ARRAY['marmot']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('arcteryx', 'Arc''teryx', ARRAY['arcteryx']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('pendleton', 'Pendleton', ARRAY['pendleton']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('nike', 'Nike', ARRAY['nike']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('adidas', 'adidas', ARRAY['adidas']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('jordan', 'Jordan', ARRAY['airjordan','jordan']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('puma', 'PUMA', ARRAY['puma']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('reebok', 'Reebok', ARRAY['reebok']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('newbalance', 'New Balance', ARRAY['newbalance']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('underarmour', 'Under Armour', ARRAY['ua','underarmour']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('vans', 'Vans', ARRAY['vans']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('converse', 'Converse', ARRAY['converse']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('asics', 'ASICS', ARRAY['asics']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('fila', 'Fila', ARRAY['fila']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('champion', 'Champion', ARRAY['champion']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('lululemon', 'Lululemon', ARRAY['lululemon']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('gymshark', 'Gymshark', ARRAY['gymshark']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('tommyhilfiger', 'Tommy Hilfiger', ARRAY['tommyhilfiger']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('ralphlauren', 'Ralph Lauren', ARRAY['ralphlauren']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('poloralphlauren', 'Polo Ralph Lauren', ARRAY['poloralphlauren']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('calvinklein', 'Calvin Klein', ARRAY['calvinklein']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('guess', 'GUESS', ARRAY['guess']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('abercrombiefitch', 'Abercrombie & Fitch', ARRAY['abercrombie','abercrombiefitch']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('hollister', 'Hollister', ARRAY['hollister']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('americaneagle', 'American Eagle', ARRAY['americaneagle']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('aeropostale', 'Aeropostale', ARRAY['aeropostale']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('gap', 'Gap', ARRAY['gap']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('oldnavy', 'Old Navy', ARRAY['oldnavy']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('bananarepublic', 'Banana Republic', ARRAY['bananarepublic']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('jcrew', 'J.Crew', ARRAY['jcrew']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('uniqlo', 'Uniqlo', ARRAY['uniqlo']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('hanes', 'Hanes', ARRAY['hanes']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('gildan', 'Gildan', ARRAY['gildan']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('nautica', 'Nautica', ARRAY['nautica']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('supreme', 'Supreme', ARRAY['supreme']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('stssy', 'Stüssy', ARRAY['stussy']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('harleydavidson', 'Harley-Davidson', ARRAY['harleydavidson']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('michaelkors', 'Michael Kors', ARRAY['michaelkors']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('coach', 'Coach', ARRAY['coach']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('katespade', 'Kate Spade', ARRAY['katespade']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('gucci', 'Gucci', ARRAY['gucci']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('versace', 'Versace', ARRAY['versace']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389'),
  ('burberry', 'Burberry', ARRAY['burberry']::text[], 'seed:brand-normalize.ts', 0.90, true, 'migration:00389')
on conflict (brand_key) do nothing;

-- ── Seed brand_size_charts from SIZING_CHARTS (sizing-charts.ts, US-1088) ──
insert into public.brand_size_charts
  (brand_key, brand_label, brand_match, department, garment, category_match, rows, note, source_url, confidence, verified, updated_by) values
  ('lululemon', 'Lululemon', ARRAY['lululemon','lulu']::text[], 'Women', 'Bottoms (leggings / pants)', ARRAY['bottom','legging','pant','short','jogger','tight']::text[], $json$[{"size":"0","measurements":{"waist":"24-24.5","hip":"33-34"}},{"size":"2","measurements":{"waist":"25-25.5","hip":"34-35"}},{"size":"4","measurements":{"waist":"26.5-27","hip":"35.5-36.5"}},{"size":"6","measurements":{"waist":"28-28.5","hip":"37-38"}},{"size":"8","measurements":{"waist":"29.5-30","hip":"38.5-39.5"}},{"size":"10","measurements":{"waist":"31-31.5","hip":"40-41"}},{"size":"12","measurements":{"waist":"32.5-33","hip":"41.5-42.5"}},{"size":"14","measurements":{"waist":"34-34.5","hip":"43-44"}}]$json$::jsonb, 'Lululemon women''s bottoms run numeric 0–14. Waist is the primary signal; hip secondary. Align/Wunder-style waistbands lie flat — measure flat and double the waistband width.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('lululemon', 'Lululemon', ARRAY['lululemon','lulu']::text[], 'Women', 'Tops', ARRAY['top','tank','tee','shirt','bra','hoodie','jacket','long sleeve']::text[], $json$[{"size":"0","measurements":{"bust":"30-31"}},{"size":"2","measurements":{"bust":"31.5-32.5"}},{"size":"4","measurements":{"bust":"33-34"}},{"size":"6","measurements":{"bust":"34.5-35.5"}},{"size":"8","measurements":{"bust":"36-37"}},{"size":"10","measurements":{"bust":"38-39"}},{"size":"12","measurements":{"bust":"40-41"}},{"size":"14","measurements":{"bust":"42-43"}}]$json$::jsonb, 'Lululemon women''s tops run numeric 0–14. Bust is the primary signal.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('lululemon', 'Lululemon', ARRAY['lululemon','lulu']::text[], 'Men', 'Tops', ARRAY['top','tee','shirt','polo','hoodie','jacket','long sleeve']::text[], $json$[{"size":"XS","measurements":{"chest":"33-35"}},{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$json$::jsonb, 'Lululemon men''s tops run alpha XS–XXL; chest is the primary signal.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('lululemon', 'Lululemon', ARRAY['lululemon','lulu']::text[], 'Men', 'Bottoms (ABC / pants / shorts)', ARRAY['bottom','pant','short','jogger','trouser']::text[], $json$[{"size":"28","measurements":{"waist":"28"}},{"size":"30","measurements":{"waist":"30"}},{"size":"32","measurements":{"waist":"32"}},{"size":"34","measurements":{"waist":"34"}},{"size":"36","measurements":{"waist":"36"}},{"size":"38","measurements":{"waist":"38"}},{"size":"40","measurements":{"waist":"40"}}]$json$::jsonb, 'Lululemon men''s bottoms are labeled by waist in inches (28–40).', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('nike', 'Nike', ARRAY['nike']::text[], 'Men', 'Tops', ARRAY['top','tee','shirt','polo','hoodie','jacket','jersey']::text[], $json$[{"size":"S","measurements":{"chest":"35-37.5"}},{"size":"M","measurements":{"chest":"38-41"}},{"size":"L","measurements":{"chest":"42-44.5"}},{"size":"XL","measurements":{"chest":"45-48.5"}},{"size":"XXL","measurements":{"chest":"49-52.5"}}]$json$::jsonb, 'Nike men''s apparel runs alpha; chest is the primary signal.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('nike', 'Nike', ARRAY['nike']::text[], 'Women', 'Tops', ARRAY['top','tee','shirt','tank','sports bra','hoodie','jacket']::text[], $json$[{"size":"XS","measurements":{"bust":"30-32"}},{"size":"S","measurements":{"bust":"33-35"}},{"size":"M","measurements":{"bust":"36-38.5"}},{"size":"L","measurements":{"bust":"39-42.5"}},{"size":"XL","measurements":{"bust":"43-46.5"}}]$json$::jsonb, 'Nike women''s apparel runs alpha; bust is the primary signal.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('athleta', 'Athleta', ARRAY['athleta']::text[], 'Women', 'Tops', ARRAY['top','tee','shirt','tank','bra','hoodie','jacket']::text[], $json$[{"size":"XXS","measurements":{"bust":"30-31"}},{"size":"XS","measurements":{"bust":"32-33"}},{"size":"S","measurements":{"bust":"34-35"}},{"size":"M","measurements":{"bust":"36-37.5"}},{"size":"L","measurements":{"bust":"38.5-40"}},{"size":"XL","measurements":{"bust":"41-43"}}]$json$::jsonb, 'Athleta women''s tops run alpha (XXS–XL); bust is the primary signal.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('athleta', 'Athleta', ARRAY['athleta']::text[], 'Women', 'Bottoms (leggings / pants)', ARRAY['bottom','legging','pant','short','tight','jogger']::text[], $json$[{"size":"XXS","measurements":{"waist":"24-25","hip":"33-34"}},{"size":"XS","measurements":{"waist":"26-27","hip":"35-36"}},{"size":"S","measurements":{"waist":"28-29","hip":"37-38.5"}},{"size":"M","measurements":{"waist":"30-31.5","hip":"39.5-41"}},{"size":"L","measurements":{"waist":"32.5-34","hip":"42-43.5"}},{"size":"XL","measurements":{"waist":"35-37","hip":"44.5-46.5"}}]$json$::jsonb, 'Athleta women''s bottoms run alpha (XXS–XL); waist is the primary signal.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('levis', 'Levi''s', ARRAY['levi','levi''s','levis']::text[], 'Men', 'Jeans (waist x inseam)', ARRAY['jean','pant','denim','bottom','trouser']::text[], $json$[{"size":"W29","measurements":{"waist":"29"}},{"size":"W30","measurements":{"waist":"30"}},{"size":"W31","measurements":{"waist":"31"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W33","measurements":{"waist":"33"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb, 'Levi''s men''s jeans are labeled W (waist) x L (inseam) in inches; the W number is the flat-waistband measurement doubled.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('levis', 'Levi''s', ARRAY['levi','levi''s','levis']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom']::text[], $json$[{"size":"24","measurements":{"waist":"24-24.5","hip":"33-34"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34-35"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35-36"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36-37"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37-38"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38-39"}},{"size":"30","measurements":{"waist":"30-31","hip":"39-40.5"}},{"size":"31","measurements":{"waist":"31-32","hip":"40.5-41.5"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42-43"}},{"size":"34","measurements":{"waist":"34.5-35.5","hip":"44-45"}}]$json$::jsonb, 'Levi''s women''s jeans use a numeric waist label (24–34) ≈ natural waist in inches; hip rises ~9-10in over the waist.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('madewell', 'Madewell', ARRAY['madewell']::text[], 'Women', 'Jeans (numeric waist)', ARRAY['jean','pant','denim','bottom']::text[], $json$[{"size":"23","measurements":{"waist":"23-23.5","hip":"32.5-33.5"}},{"size":"24","measurements":{"waist":"24-24.5","hip":"33.5-34.5"}},{"size":"25","measurements":{"waist":"25-25.5","hip":"34.5-35.5"}},{"size":"26","measurements":{"waist":"26-26.5","hip":"35.5-36.5"}},{"size":"27","measurements":{"waist":"27-27.5","hip":"36.5-37.5"}},{"size":"28","measurements":{"waist":"28-28.5","hip":"37.5-38.5"}},{"size":"29","measurements":{"waist":"29-29.5","hip":"38.5-39.5"}},{"size":"30","measurements":{"waist":"30-31","hip":"39.5-41"}},{"size":"31","measurements":{"waist":"31-32","hip":"41-42"}},{"size":"32","measurements":{"waist":"32.5-33.5","hip":"42.5-43.5"}}]$json$::jsonb, 'Madewell women''s denim uses a numeric waist label (23–35) ≈ natural waist in inches.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('thenorthfacepatagoniaouterwear', 'The North Face / Patagonia (outerwear)', ARRAY['north face','patagonia','columbia','arc''teryx','arcteryx']::text[], 'Unisex', 'Outerwear / jackets (alpha)', ARRAY['jacket','coat','fleece','vest','outerwear','shell','parka']::text[], $json$[{"size":"XS","measurements":{"chest":"33-35"}},{"size":"S","measurements":{"chest":"35-38"}},{"size":"M","measurements":{"chest":"38-41"}},{"size":"L","measurements":{"chest":"42-45"}},{"size":"XL","measurements":{"chest":"46-49"}},{"size":"XXL","measurements":{"chest":"50-53"}}]$json$::jsonb, 'Outdoor outerwear runs alpha; chest is the primary signal. Men''s and women''s overlap — confirm department from the cut/colorway.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('genericwomensalpha', 'Generic women''s alpha', ARRAY[]::text[], 'Women', 'Tops & dresses (alpha)', ARRAY['top','tank','tee','shirt','dress','blouse','sweater','hoodie']::text[], $json$[{"size":"XS","measurements":{"bust":"31-32","waist":"24-25"}},{"size":"S","measurements":{"bust":"33-35","waist":"26-28"}},{"size":"M","measurements":{"bust":"36-38","waist":"29-31"}},{"size":"L","measurements":{"bust":"39-41","waist":"32-34"}},{"size":"XL","measurements":{"bust":"42-45","waist":"35-38"}}]$json$::jsonb, 'Generic US women''s alpha sizing — use when no brand-specific chart applies.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('genericmensalpha', 'Generic men''s alpha', ARRAY[]::text[], 'Men', 'Tops (alpha)', ARRAY['top','tee','shirt','polo','sweater','hoodie','jacket']::text[], $json$[{"size":"S","measurements":{"chest":"35-37"}},{"size":"M","measurements":{"chest":"38-40"}},{"size":"L","measurements":{"chest":"41-43"}},{"size":"XL","measurements":{"chest":"44-46"}},{"size":"XXL","measurements":{"chest":"47-49"}}]$json$::jsonb, 'Generic US men''s alpha sizing (chest) — use when no brand-specific chart applies.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389'),
  ('genericmenspants', 'Generic men''s pants', ARRAY[]::text[], 'Men', 'Pants (waist x inseam)', ARRAY['pant','jean','chino','trouser','short','bottom']::text[], $json$[{"size":"W30","measurements":{"waist":"30"}},{"size":"W32","measurements":{"waist":"32"}},{"size":"W34","measurements":{"waist":"34"}},{"size":"W36","measurements":{"waist":"36"}},{"size":"W38","measurements":{"waist":"38"}}]$json$::jsonb, 'Men''s pants are labeled W (waist) x L (inseam). Read the flat waistband (double it) for W and the inside-leg seam for L. Common inseams: 30/32/34.', 'seed:sizing-charts.ts', 0.75, true, 'migration:00389')
on conflict (brand_key, department, garment) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00389') on conflict do nothing;
