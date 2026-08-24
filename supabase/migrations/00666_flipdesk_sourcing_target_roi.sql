-- US-2851: the margin a seller is actually sourcing to.
--
-- The sourcing ceiling is "the highest price to pay for this garment", and that
-- number is meaningless without a target return. FlipDesk had no per-seller
-- margin setting anywhere: the autolister's "floor at % margin" is typed fresh
-- into a bulk action and never stored, and automation_rules.margin_floor_pct is
-- a per-rule offer threshold, not a sourcing goal.
--
-- NULL means "use the product default", which is DECISION_MAYBE_ROI in
-- lib/scout-decision.ts, the same threshold that already decides whether the
-- scout calls an item a maybe. Defaulting in the column instead would freeze
-- today's number into every existing row and split the two apart the first time
-- one of them changed.
--
-- Stored as whole percent rather than a fraction: it is typed by a person into
-- a box that says %, and a 0.3-vs-30 mix-up in a column that sets a spending
-- ceiling is worth designing out.

alter table public.flipdesk_settings
  add column if not exists sourcing_target_roi_pct integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'flipdesk_settings_sourcing_roi_range'
  ) then
    alter table public.flipdesk_settings
      add constraint flipdesk_settings_sourcing_roi_range
      check (sourcing_target_roi_pct is null
             or (sourcing_target_roi_pct >= 0 and sourcing_target_roi_pct <= 1000));
  end if;
end $$;

comment on column public.flipdesk_settings.sourcing_target_roi_pct is
  'US-2851: target return on cost for the sourcing ceiling, whole percent. NULL = product default (DECISION_MAYBE_ROI).';

insert into public.applied_migrations (version) values ('00666') on conflict do nothing;
