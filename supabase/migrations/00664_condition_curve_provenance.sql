-- US-2847: a curve now has to say where its numbers came from.
--
-- condition_price_curves has been written only by condition-index-seedgen.ts,
-- which GENERATES points by filtering comps on the eBay conditionId a grade maps
-- to. US-2841 replaces that for cells we have measured: reads of real listing
-- photos, fitted to a price-vs-grade slope. Both live in this table, so the row
-- has to carry which one it is, or the public page cannot tell the truth about
-- itself.
--
-- Default is 'seeded' so every existing row keeps describing itself correctly
-- without a backfill.

alter table public.condition_price_curves
  add column if not exists provenance text not null default 'seeded';

alter table public.condition_price_curves
  add column if not exists slope_cents_per_point numeric;

alter table public.condition_price_curves
  add column if not exists fit_confidence numeric;

alter table public.condition_price_curves
  add column if not exists measured_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'condition_price_curves_provenance_chk'
  ) then
    alter table public.condition_price_curves
      add constraint condition_price_curves_provenance_chk
      check (provenance in ('seeded', 'measured'));
  end if;
end $$;

-- A measured row must carry the fit that made it. Without this a row could
-- claim to be measured while holding nothing but seed points, which is the one
-- lie this column exists to prevent.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'condition_price_curves_measured_has_fit'
  ) then
    alter table public.condition_price_curves
      add constraint condition_price_curves_measured_has_fit
      check (
        provenance <> 'measured'
        or (slope_cents_per_point is not null and measured_at is not null)
      );
  end if;
end $$;

comment on column public.condition_price_curves.provenance is
  'US-2847: seeded (generated from conditionId-filtered comps) or measured (fitted from comp condition reads).';

create index if not exists condition_price_curves_provenance_idx
  on public.condition_price_curves (provenance);

insert into public.applied_migrations (version) values ('00664') on conflict do nothing;
