-- US-3387: retire the 23 size-chart rows a rename orphaned.
--
-- The conflict key on every migration that seeds brand_size_charts is
-- (brand_key, department, garment). RENAMING a garment scope therefore does not
-- update the old row, it inserts a second one, and both survive. The resolver
-- reads every row for a brand, narrows by CATEGORY ONLY and keeps the first
-- three, so the stale row and its replacement land in the same prompt and on a
-- brand with several charts the stale one pushes a sourced chart out entirely.
--
-- 00782 retired 14 of these and was believed exhaustive. It was not: its list
-- came from diffing the original 00498 against the regenerated one, which can
-- only ever surface rows 00498 itself seeded. Duluth Trading's fourth tops
-- chart, seeded by 00776, was invisible to that method and is in this list.
--
-- THE LIST IS NOT WRITTEN TWICE BY ACCIDENT. It is HELD_BY_00793 in
-- services/edge-functions/src/tests/sizing-chart-orphans_test.ts, and that
-- guard asserts this file deletes exactly those rows and no others. It also
-- holds the 26 orphans that are NOT renames -- 15 hand-written charts with no
-- rival and 11 whose only rival is in another department -- each with the
-- reason it stays. Read that file before adding a row here.
--
-- Idempotent: a DELETE matching nothing on a second run is a no-op.

delete from public.brand_size_charts t
using (values
  ('arcteryx',        'Men',   'Bottoms (alpha, body inches converted from the brand''s cm)'),
  ('arcteryx',        'Women', 'Bottoms (alpha, body inches converted from the brand''s cm)'),
  ('beyondyoga',      'Women', 'Bottoms'),
  ('dickies',         'Men',   'Tops & outerwear (alpha, body inches)'),
  ('duluthtradingco', 'Men',   'Tops & outerwear (alpha, body inches)'),
  ('fabletics',       'Women', 'Bottoms'),
  ('gymshark',        'Women', 'Bottoms'),
  ('levis',           'Men',   'Tops & outerwear (alpha, body inches)'),
  ('levis',           'Women', 'Tops, outerwear & dresses (alpha, body inches)'),
  ('luckybrand',      'Men',   'Tops & outerwear (alpha, body inches)'),
  ('luckybrand',      'Women', 'Tops, outerwear & dresses (alpha/numeric, body inches)'),
  ('madewell',        'Women', 'Tops & outerwear (alpha/numeric, body inches)'),
  ('skims',           'Women', 'Tops & outerwear (alpha/numeric, body inches)'),
  ('sweatybetty',     'Women', 'Bottoms'),
  ('tommyhilfiger',   'Men',   'Bottoms (WAIST TAG 28-50 — the number is the tag, not the body)'),
  ('tommyhilfiger',   'Men',   'Outerwear (alpha, body inches)'),
  ('tommyhilfiger',   'Women', 'Bottoms (alpha/numeric, body inches)'),
  ('tommyhilfiger',   'Women', 'Outerwear (alpha/numeric, body inches)'),
  ('truereligion',    'Men',   'Tops & outerwear (alpha, body inches)'),
  ('truereligion',    'Women', 'Tops & outerwear (alpha, body inches)'),
  ('underarmour',     'Women', 'Bottoms'),
  ('vuori',           'Men',   'Bottoms'),
  ('vuori',           'Women', 'Bottoms')
) as v(brand_key, department, garment)
where t.brand_key  = v.brand_key
  and t.department = v.department
  and t.garment    = v.garment;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00793') on conflict do nothing;
