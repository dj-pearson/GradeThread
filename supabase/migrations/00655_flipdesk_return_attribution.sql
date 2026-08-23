-- US-2823: what actually predicts a return, past the grade band.
--
-- flipdesk_return_reduction (00168) answers "do low grades come back more".
-- Yes, and that is as far as it goes: the overall grade is one number, and a
-- seller who learns their sub-6 items return more still does not know whether
-- to fix their photos, their measurements or their odour handling.
--
-- This reports the same fulfilled/return arithmetic against the FIVE FACTOR
-- SCORES the grader already produces, and against whether a recorded defect was
-- DISCLOSED. Same denominator as 00168, checked rather than assumed: "fulfilled"
-- is sale_status in ('completed','refunded') and a "return" is 'refunded'. A
-- different denominator here would silently disagree with the Returns tab.
--
-- ── THE DISCLOSURE RULE, stated so it can be argued with ────────────────────
-- A defect on a sold item counts as DISCLOSED when EITHER:
--   (a) the item has at least one item_photos row with photo_type = 'defect', or
--   (b) the latest listing_description contains the defect's own text
--       (defect_type with underscores as spaces, or the free-text `defect`),
--       matched case-insensitively as a substring.
-- Crude on purpose. It is the rule a seller can check by looking at their own
-- listing, and src/lib/return-attribution.ts carries the same rule as a tested
-- function so the intent cannot drift without something going red.
--
-- SECURITY INVOKER, like 00168. Everything here is the caller's own data and
-- RLS already scopes inventory_items, listings, sales and grade_reports
-- (grade_reports via submissions.user_id). No cohort, so no k-anonymity
-- question and no SECURITY DEFINER.

BEGIN;

create or replace function public.flipdesk_return_attribution(
  p_period_start date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with cfg as (
    -- Mirrors MIN_RETURN_SAMPLE in src/lib/flipdesk-returns-analytics.ts. A
    -- return is a rare event; a rate on four sales is not a rate.
    select 10::int as min_sample
  ),
  base as (
    select
      i.id,
      sa.status as sale_status,
      (sa.status = 'refunded') as is_return,
      l.listing_description,
      gr.fabric_condition_score,
      gr.structural_integrity_score,
      gr.cosmetic_appearance_score,
      gr.functional_elements_score,
      gr.odor_cleanliness_score,
      gr.defects_found,
      exists (
        select 1 from public.item_photos p
        where p.inventory_item_id = i.id and p.photo_type = 'defect'
      ) as has_defect_photo
    from public.inventory_items i
    join lateral (
      select s.status, coalesce(s.sold_at, s.sale_date) as sale_date
      from public.sales s
      where s.inventory_item_id = i.id
      order by coalesce(s.sold_at, s.sale_date) desc nulls last, s.created_at desc
      limit 1
    ) sa on true
    left join lateral (
      select listing_description
      from public.listings
      where listings.inventory_item_id = i.id
      order by listings.listed_at desc nulls last, listings.created_at desc
      limit 1
    ) l on true
    left join lateral (
      select r.defects_found,
             r.fabric_condition_score, r.structural_integrity_score,
             r.cosmetic_appearance_score, r.functional_elements_score,
             r.odor_cleanliness_score
      from public.grade_reports r
      where r.superseded_at is null
        and (
          r.id = i.grade_report_id
          or (i.submission_id is not null and r.submission_id = i.submission_id)
          or r.submission_id in (
            select fgs.submission_id
            from public.flipdesk_grading_submissions fgs
            where fgs.inventory_item_id = i.id and fgs.submission_id is not null
          )
        )
      order by r.created_at desc
      limit 1
    ) gr on true
    where sa.status in ('completed', 'refunded')
      and (p_period_start is null or sa.sale_date::date >= p_period_start)
  ),
  -- One row per item per factor, so the five bands are computed once rather
  -- than as five near-identical blocks.
  factor_rows as (
    select id, is_return, f.factor, f.score,
      case
        when f.score is null then 'ungraded'
        when f.score <= 6 then 'low'
        when f.score <= 8 then 'mid'
        else 'high'
      end as band
    from base
    cross join lateral (values
      ('fabric',     fabric_condition_score),
      ('structural', structural_integrity_score),
      ('cosmetic',   cosmetic_appearance_score),
      ('functional', functional_elements_score),
      ('odor',       odor_cleanliness_score)
    ) as f(factor, score)
  ),
  factor_agg as (
    select factor, band,
      count(*)::int as fulfilled,
      count(*) filter (where is_return)::int as returns
    from factor_rows
    group by factor, band
  ),
  -- Disclosure, applied per (item, defect). The rule is in the header.
  defect_rows as (
    select distinct
      b.id,
      b.is_return,
      coalesce(
        nullif(trim(d.value ->> 'defect_type'), ''),
        nullif(lower(trim(d.value ->> 'defect')), ''),
        'unspecified'
      ) as defect_key,
      coalesce(nullif(trim(d.value ->> 'severity'), ''), 'unspecified') as severity,
      -- ⚠ THE COALESCE IS LOAD-BEARING, not defensive noise. position(null in x)
      -- is NULL, so a defect with no photo, no defect_type and no free text
      -- would evaluate to NULL — and NULL satisfies neither `filter (where
      -- disclosed)` nor `filter (where not disclosed)`, so the row would
      -- disappear from BOTH sides of the comparison rather than land on one.
      -- An undisclosed defect with no text is precisely the worst case, and it
      -- is the one that would have gone missing.
      coalesce(
        b.has_defect_photo
        -- Each needle is NULLIF'd to null when blank BEFORE the search, because
        -- position('' in anything) returns 1 and an empty needle would mark
        -- every defect disclosed.
        or position(
             lower(replace(nullif(trim(d.value ->> 'defect_type'), ''), '_', ' '))
             in lower(coalesce(b.listing_description, ''))
           ) > 0
        or position(
             lower(nullif(trim(d.value ->> 'defect'), ''))
             in lower(coalesce(b.listing_description, ''))
           ) > 0,
        false
      ) as disclosed
    from base b
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(b.defects_found) = 'array'
        then b.defects_found else '[]'::jsonb end
    ) as d
  ),
  defect_agg as (
    select defect_key, severity,
      count(*) filter (where disclosed)::int as disclosed_n,
      count(*) filter (where disclosed and is_return)::int as disclosed_returns,
      count(*) filter (where not disclosed)::int as undisclosed_n,
      count(*) filter (where not disclosed and is_return)::int as undisclosed_returns
    from defect_rows
    group by defect_key, severity
  ),
  factor_labels(factor, ord) as (
    values ('fabric', 1), ('structural', 2), ('cosmetic', 3),
           ('functional', 4), ('odor', 5)
  ),
  band_labels(band, band_label, band_ord) as (
    values
      ('low',      '6.0 or lower',  1),
      ('mid',      '6.5 to 8.0',    2),
      ('high',     'Above 8.0',     3),
      ('ungraded', 'No score',      4)
  )
  select jsonb_build_object(
    'periodStart', p_period_start,
    'minSample', (select min_sample from cfg),
    'overall', jsonb_build_object(
      'fulfilled', (select count(*)::int from base),
      'returns', (select count(*) filter (where is_return)::int from base),
      'graded', (select count(*) filter (where fabric_condition_score is not null)::int from base)
    ),
    'factors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'factor', fl.factor,
        'bands', (
          select jsonb_agg(jsonb_build_object(
            'band', bl.band,
            'label', bl.band_label,
            'fulfilled', coalesce(fa.fulfilled, 0),
            'returns', coalesce(fa.returns, 0),
            -- Rate is NULL under the sample floor, never 0. A band with three
            -- sales and no return is not a 0% return rate.
            'rate', case
              when coalesce(fa.fulfilled, 0) >= (select min_sample from cfg)
              then round(fa.returns::numeric / fa.fulfilled, 4) end
          ) order by bl.band_ord)
          from band_labels bl
          left join factor_agg fa on fa.factor = fl.factor and fa.band = bl.band
        )
      ) order by fl.ord)
      from factor_labels fl
    ), '[]'::jsonb),
    'defects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'defect', defect_key,
        'severity', severity,
        'disclosedCount', disclosed_n,
        'disclosedReturns', disclosed_returns,
        'disclosedRate', case when disclosed_n >= (select min_sample from cfg)
          then round(disclosed_returns::numeric / disclosed_n, 4) end,
        'undisclosedCount', undisclosed_n,
        'undisclosedReturns', undisclosed_returns,
        'undisclosedRate', case when undisclosed_n >= (select min_sample from cfg)
          then round(undisclosed_returns::numeric / undisclosed_n, 4) end
      ) order by undisclosed_returns desc, defect_key, severity)
      from defect_agg
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.flipdesk_return_attribution(date) to authenticated;
grant execute on function public.flipdesk_return_attribution(date) to service_role;

insert into public.applied_migrations (version) values ('00655') on conflict do nothing;

COMMIT;
