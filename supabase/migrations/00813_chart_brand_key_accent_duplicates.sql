-- 00813: four size charts are stored twice, and the copy grading reads is the
-- one with no source (US-3443).
--
-- brandKey is `raw.toLowerCase().replace(/[^a-z0-9]/g, "")`
-- (services/edge-functions/src/lib/brand-normalize.ts:25). It DROPS an accented
-- letter rather than transliterating it, so "Kuhl" with an umlaut keys as `khl`
-- and the Swedish brand keys as `fjllrven`. resolveBrandKnowledgePack does
-- `.eq("brand_key", brandKey(canonicalizeBrand(brand)))`, so those are the keys
-- grading reaches.
--
-- 00472 wrote chart rows by hand under `kuhl` and `fjallraven`, transliterating
-- the accent. 00498's generator wrote the SAME four charts from the seed under
-- `khl` and `fjllrven`. Measured on a cluster carrying every migration: the
-- eight rows are identical in rows, category_match, brand_match, note and
-- measurement_basis. They differ in exactly one way, and it is the wrong way
-- round -- 00472's rows carry `source_url` and `confidence` 0.55, and 00472's
-- rows are the UNREACHABLE ones. So grading has been served the unsourced copy
-- while the sourced one sat beside it, invisible.
--
-- THIS FILE DOES TWO THINGS AND NEITHER CHANGES A MEASUREMENT.
--   1. Copies source_url and confidence from the unreachable row onto the
--      reachable one, which is the provenance 00472 sourced and 00498 lost.
--   2. Deletes the four unreachable rows.
--
-- scripts/check-chart-brand-keys.mjs is the guard: it fails when any row's
-- brand_key is not what brandKey(brand_label) computes, and when one chart is
-- stored under two keys. It runs in the db lane.
--
-- WHY DELETE RATHER THAN LEAVE THEM. They are dead to grading and they are the
-- reason the corpus counts disagree with the seed. An admin browsing by key can
-- still reach them today, which is the only thing lost, and what they would
-- find is a duplicate of a row that is now strictly better.
--
-- Idempotent: each UPDATE is guarded on the value not already being set, and
-- each DELETE matches nothing on a second run.

do $$
declare
  moved   int := 0;
  deleted int := 0;
begin
  -- 1. Carry the provenance across, keyed on the pair being the same chart.
  update public.brand_size_charts live
     set source_url = dead.source_url,
         confidence = dead.confidence
    from public.brand_size_charts dead
   where live.brand_key  in ('khl', 'fjllrven')
     and dead.brand_key  in ('kuhl', 'fjallraven')
     and live.brand_label = dead.brand_label
     and live.department  = dead.department
     and live.garment     = dead.garment
     and live.source_url is null
     and dead.source_url is not null;
  get diagnostics moved = row_count;

  -- 2. Drop the rows no lookup can reach.
  delete from public.brand_size_charts
   where brand_key in ('kuhl', 'fjallraven');
  get diagnostics deleted = row_count;

  raise notice '[00813] provenance moved onto % reachable row(s); % unreachable row(s) deleted (0 and 0 on a re-run)',
    moved, deleted;
end;
$$;

-- Readback inside the file: "applied" and "took effect" are different claims.
do $$
declare
  bad int;
begin
  select count(*) into bad
    from public.brand_size_charts
   where brand_key <> regexp_replace(lower(brand_label), '[^a-z0-9]', '', 'g')
     and brand_key not in ('golfshoewidth', 'tailoringmenswear', 'westernbootwidth');
  if bad > 0 then
    raise exception '[00813] % chart row(s) still carry a brand_key the resolver cannot compute', bad;
  end if;
  raise notice '[00813] every chart row outside the three convention keys carries the key the resolver computes';
end;
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00813') on conflict do nothing;
