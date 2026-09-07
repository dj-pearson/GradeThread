-- US-3126: fix the last 45 unsourced tag_eras rows and VALIDATE all three
-- brand-provenance constraints.
--
-- Three constraints have sat NOT VALID since they were created:
--
--     brand_knowledge_sourced            brand_fact_is_sourced(source_url, confidence)
--     brand_colorways_sourced            brand_fact_is_sourced(source_url, confidence)
--     brand_knowledge_tag_eras_sourced   tag_eras_all_sourced(tag_eras)
--
-- NOT VALID means Postgres never checked the rows that already existed. It does
-- NOT mean the constraint is inert, and that difference has cost this project
-- real time: Postgres checks any row an UPDATE touches, so a migration adding a
-- registered number to a 2026-07 brand row fails on a constraint about tag eras.
-- 00748 hit it with two rows and 00757 with eighty. Both had to carry a
-- provenance fix they were not otherwise about.
--
-- -- THE NUMBERS, MEASURED RATHER THAN INHERITED ------------------------------
--
-- US-3126 says 11 rows block these. That figure was an estimate and was wrong
-- in both directions over time:
--
--     at 00748    90 rows failed tag_eras_all_sourced
--     after 00748 88
--     after 00757 45   (00757 fixed 43 as a side effect of writing RNs)
--     here         0
--
-- The two brand_fact_is_sourced constraints failed on ZERO rows the whole time.
-- Nothing was ever blocking them; they were left NOT VALID and never revisited.
--
-- -- THE FIX FOR THE REMAINING 45 --------------------------------------------
--
-- Same narrow fix 00748 and 00757 used, now applied to the rest. tag_eras_all_
-- sourced requires every era whose `years` names a real year or decade to carry
-- a source_url and a numeric confidence. All 45 rows already HAVE a row-level
-- source_url and confidence -- checked, not assumed -- so each datable era
-- inherits what the row itself asserts.
--
-- That restates an existing claim rather than inventing a citation. It does not
-- pretend the eras were independently researched, and it does not raise any
-- confidence: an era inherits the row's own number, whatever that number is.
--
-- -- WHY VALIDATING MATTERS MORE THAN THE 45 ---------------------------------
--
-- Once validated, these constraints stop being a trap that fires on unrelated
-- work and become what they were meant to be: a rule that new rows must carry
-- provenance. A future brand migration gets told immediately, rather than
-- discovering it while trying to write something else.
--
-- VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock. It does not block
-- reads or writes, only concurrent schema changes on the same table.

do $$
begin
  -- 1. Give every datable era the provenance its own row already asserts.
  update public.brand_knowledge k
     set tag_eras = (
       select jsonb_agg(
                case when coalesce(e ->> 'years', '') ~ '(\d{4}|\d0s)'
                      and (coalesce(e ->> 'source_url', '') = ''
                           or jsonb_typeof(e -> 'confidence') is distinct from 'number')
                     then e || jsonb_build_object('source_url', k.source_url,
                                                  'confidence', k.confidence)
                     else e end)
         from jsonb_array_elements(k.tag_eras) e)
   where not public.tag_eras_all_sourced(k.tag_eras)
     and coalesce(btrim(k.source_url), '') <> ''
     and k.confidence is not null;
end $$;

-- 2. Refuse to validate on a lie. If anything still fails, this migration stops
--    here rather than validating a constraint the data does not satisfy --
--    which Postgres would reject anyway, but with a far less useful message.
do $$
declare
  bad_eras int;
  bad_kb int;
  bad_cw int;
begin
  select count(*) into bad_eras from public.brand_knowledge
   where not public.tag_eras_all_sourced(tag_eras);
  select count(*) into bad_kb from public.brand_knowledge
   where not public.brand_fact_is_sourced(source_url, confidence);
  select count(*) into bad_cw from public.brand_colorways
   where not public.brand_fact_is_sourced(source_url, confidence);
  if bad_eras > 0 or bad_kb > 0 or bad_cw > 0 then
    raise exception
      'provenance still unsatisfied: % tag_eras, % brand_knowledge, % brand_colorways',
      bad_eras, bad_kb, bad_cw;
  end if;
end $$;

-- 3. Validate. Guarded on convalidated so a re-run is a no-op rather than a
--    second full-table scan.
do $$
begin
  if not (select convalidated from pg_constraint
           where conrelid = 'public.brand_knowledge'::regclass
             and conname = 'brand_knowledge_tag_eras_sourced') then
    alter table public.brand_knowledge validate constraint brand_knowledge_tag_eras_sourced;
  end if;
  if not (select convalidated from pg_constraint
           where conrelid = 'public.brand_knowledge'::regclass
             and conname = 'brand_knowledge_sourced') then
    alter table public.brand_knowledge validate constraint brand_knowledge_sourced;
  end if;
  if not (select convalidated from pg_constraint
           where conrelid = 'public.brand_colorways'::regclass
             and conname = 'brand_colorways_sourced') then
    alter table public.brand_colorways validate constraint brand_colorways_sourced;
  end if;
end $$;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00760') on conflict do nothing;
