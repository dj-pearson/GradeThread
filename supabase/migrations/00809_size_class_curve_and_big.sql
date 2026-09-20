-- 00809: record the size class on the two charts whose scope declares one in
-- words the detector did not read.
--
-- US-3406. `size_class` is derived from the chart's garment scope by
-- detectSizeClass (services/edge-functions/src/lib/size-systems.ts), and
-- 00499's generator writes a row only when a system is readable OR the class
-- is non-standard. Two charts declare an extended class in the seed and derived
-- as "standard", so the generator emitted nothing for them and the column
-- stayed NULL in production:
--
--   tommyhilfiger | Women | Curve, tops & bottoms (body inches)   -> plus
--   brooksbrothers | Men  | Bottoms, big (body inches)            -> big_and_tall
--
-- "Curve" is Tommy Hilfiger's own name for its plus line, and a "big" chart
-- with no "tall" is still the big-and-tall dimension: that is the only extended
-- class the enum carries for it, and "standard" is the falser of the two. The
-- patterns are widened in the same commit and 00499 is regenerated to match
-- (sizing-chart-parity_test.ts asserts the two agree), but 00499 is already
-- applied and appliers compute pending by MEMBERSHIP, so it will never re-run
-- against production. This file is what moves the live rows.
--
-- Why it matters: the ranking demotes a non-standard chart so an unqualified
-- garment does not lead with a plus-size one. With the column NULL the
-- demotion reads `?? detectSizeClass(chart)`, which answered "standard" for
-- exactly these two, so the fix does nothing for them until this lands.
--
-- Idempotent: the WHERE keeps each write to the row that still lacks the
-- value, so a second run updates nothing.

-- WARNING: brand_size_charts carries a NOT VALID check, `brand_size_charts_sourced`,
-- which does not validate the existing table but DOES fire on any row this
-- updates. Both target rows were given a source_url and confidence 0.85 by
-- 00781, which is applied to prod, so this passes -- but that constraint is the
-- one statement here that can abort, and a hand re-run on this table aborted on
-- an unsourced row on 2026-09-09 (00499's header records it).
--
-- WARNING: Both UPDATEs pin an exact garment string, and 00782 and 00793 have retired
-- and renamed rows in this table before. A string that no longer matches would
-- make this file succeed, record itself and change nothing, so it COUNTS and
-- says so rather than leaving that to whoever remembers to run the readback.

do $$
declare
  n_plus int;
  n_big  int;
begin
  update public.brand_size_charts
     set size_class = 'plus'
   where brand_key = 'tommyhilfiger'
     and department = 'Women'
     and garment = 'Curve, tops & bottoms (body inches)'
     and size_class is distinct from 'plus';
  get diagnostics n_plus = row_count;

  update public.brand_size_charts
     set size_class = 'big_and_tall'
   where brand_key = 'brooksbrothers'
     and department = 'Men'
     and garment = 'Bottoms, big (body inches)'
     and size_class is distinct from 'big_and_tall';
  get diagnostics n_big = row_count;

  raise notice '[00809] size_class repair: tommyhilfiger/Curve %, brooksbrothers/Bottoms-big % (0 and 0 on a re-run; 0 and 0 on a FIRST run means the garment strings have moved)',
    n_plus, n_big;
end;
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00809') on conflict do nothing;
