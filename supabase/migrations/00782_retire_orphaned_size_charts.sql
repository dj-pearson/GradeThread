-- US-3292: delete the brand_size_charts rows that no longer exist in the code
-- corpus, so the DB stops serving charts the code retired.
--
-- THE DEFECT THIS FIXES, found while writing batch 9 of the size-chart backfill:
--
--   `brand-knowledge.ts` prefers the DB over the in-code fallback. When
--   `brand_size_charts` returns ANY row for a brand, those rows are the whole
--   answer and `SIZING_CHARTS` is never consulted for it. That is the intended
--   design.
--
--   00498 seeded the DB from the code corpus as it stood on 2026-07-29, and is
--   applied. Regenerating 00498 in place (which the US-2214 parity guard
--   requires on every corpus change) does NOT reach prod: apply-prod-migrations
--   skips every file at or below the highest recorded version.
--
--   Batches 2 through 8 RENAMED garment scopes when they widened a chart
--   ("Tops" became "Tops & outerwear", "Outerwear & wool" became "Outerwear,
--   tops & bottoms") and REPLACED two Kate Spade approximations outright. The
--   conflict key on the sourced-chart migrations is
--   (brand_key, department, garment), so a rename does not update the old row —
--   it inserts a second one. Prod therefore holds 14 rows whose garment scope
--   no longer exists in code, every one of them the pre-backfill approximation
--   that the sourced chart was written to replace.
--
--   Left alone, applying 00781 gives Woolrich, Beyond Yoga, UNTUCKit, Express
--   and J.Crew TWO charts each for the same body: the brand's own numbers and
--   the guess they superseded, competing for the same 3-chart prompt budget.
--   That is the US-1734 two-competing-charts problem, arriving by a new route.
--
-- SCOPE: exactly the 14 tuples below, listed rather than derived. A
-- "delete everything not in the current corpus" statement would also delete
-- hand-written pack rows that were never generated from code, and there is no
-- way for this file to tell those apart.
--
-- Apply AFTER 00781. Order matters only for tidiness — none of these 14 tuples
-- appears in 00781, so neither order can delete a row 00781 just wrote.
--
-- Risk: LOW. A global reference table with deny-all RLS and no tenant data.
-- Idempotent: a second run deletes nothing because the rows are already gone.

delete from public.brand_size_charts t
using (values
  ('beyondyoga',                     'Women',  'Tops'),
  ('express',                        'Women',  'Tops (US numeric 00-18 / alpha)'),
  ('jcrew',                          'Men',    'Shirts (alpha)'),
  ('katespade',                      'Women',  'Dresses (US numeric)'),
  ('katespade',                      'Women',  'Tops & knits (US alpha)'),
  ('oldnavy',                        'Women',  'Tops (alpha, RUNS LARGE)'),
  ('puma',                           'Unisex', 'Tops (alpha)'),
  ('reebok',                         'Unisex', 'Tops (alpha)'),
  ('skims',                          'Women',  'Intimates apparel / shapewear (alpha XXS-4X, body inches)'),
  ('stssy',                          'Men',    'Tops (tees & fleece, US alpha)'),
  ('thenorthfacepatagoniaouterwear', 'Unisex', 'Outerwear / jackets (alpha)'),
  ('untuckit',                       'Women',  'Tops & dresses (ALPHA XS-XL)'),
  ('woolrich',                       'Men',    'Outerwear & wool'),
  ('woolrich',                       'Women',  'Outerwear & wool')
) as v(brand_key, department, garment)
where t.brand_key  = v.brand_key
  and t.department = v.department
  and t.garment    = v.garment;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00782') on conflict do nothing;
