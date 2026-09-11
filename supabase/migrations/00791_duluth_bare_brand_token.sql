-- 00791: drop the bare 'duluth' brand token from Duluth Trading's body chart.
--
-- US-3319 triaged eighteen red size-chart guards and found one live defect:
-- the 2026-09 backfill (00781) seeded the "Men | Tops & outerwear (body
-- inches)" chart with brand_match {'duluth trading','duluthtrading','duluth'}.
-- brand_match is a word-boundary substring test, so a Duluth PACK garment (a
-- different company, est. 1882) resolved Duluth Trading's chart. The pants
-- chart already refuses the bare token and says so in its note; this brings
-- the body chart to the same rule. sizing-charts.ts and the regenerated 00498
-- carry the same change in the same commit (sizing-chart-parity_test.ts).
--
-- Idempotent: array_remove on an array without the token is a no-op, and the
-- WHERE keeps the write to rows that still carry it.

update public.brand_size_charts
   set brand_match = array_remove(brand_match, 'duluth')
 where brand_key = 'duluthtradingco'
   and 'duluth' = any(brand_match);

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00791') on conflict do nothing;
