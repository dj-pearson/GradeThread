-- US-3193: the costs the buy ceiling has been pricing at zero.
--
-- sourcingCeiling() subtracts eBay's fees from the condition-adjusted median and
-- divides by the target ROI. It subtracts nothing else — no postage, no mailer,
-- no grading fee — while the composer's own profit estimate on the very next
-- screen subtracts all three. The two disagreed in the buyer's favour, on the
-- one screen where cash actually leaves the seller's hand.
--
-- THREE COLUMNS, NOT ONE, because a seller adjusts them for different reasons.
-- Postage moves when they change service or start shipping heavier things;
-- supplies move when they buy mailers in bulk; the grading fee moves when they
-- change plan or stop grading every item. Folding them into one "overhead"
-- figure would make each of those edits a mental subtraction first.
--
-- NULL MEANS "USE THE DEFAULT", NOT ZERO — and the defaults live in code
-- (scout-decision.ts) rather than as column defaults, so they can be corrected
-- in a deploy rather than a migration. Zero remains available and means what it
-- says: a seller who genuinely pays no postage can type 0 and be believed.
--
-- DEPLOY ORDER: database first. The edge SELECTs these when it computes a
-- ceiling; against a database without them the read fails with 42703 and the
-- Scout appraisal throws. EXPECTED_SCHEMA_VERSION moves to 00770 in this commit.

alter table public.flipdesk_settings
  add column if not exists sourcing_shipping_cost_cents integer,
  add column if not exists sourcing_supplies_cost_cents integer,
  add column if not exists sourcing_grading_cost_cents  integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'flipdesk_settings_sourcing_costs_sane'
  ) then
    alter table public.flipdesk_settings
      add constraint flipdesk_settings_sourcing_costs_sane
      check (
        (sourcing_shipping_cost_cents is null
          or (sourcing_shipping_cost_cents >= 0 and sourcing_shipping_cost_cents <= 100000))
        and (sourcing_supplies_cost_cents is null
          or (sourcing_supplies_cost_cents >= 0 and sourcing_supplies_cost_cents <= 100000))
        and (sourcing_grading_cost_cents is null
          or (sourcing_grading_cost_cents >= 0 and sourcing_grading_cost_cents <= 100000))
      );
  end if;
end $$;

comment on column public.flipdesk_settings.sourcing_shipping_cost_cents is
  'What the seller expects to pay to post one garment, in cents. NULL means use the code default (the cheapest real Ground Advantage band). Subtracted before the buy ceiling divides by the target ROI.';
comment on column public.flipdesk_settings.sourcing_supplies_cost_cents is
  'Mailer, tape and label for one parcel, in cents. NULL means use the code default.';
comment on column public.flipdesk_settings.sourcing_grading_cost_cents is
  'What one GradeThread grade costs this seller, in cents. NULL means use the code default. Set to 0 by a seller who does not grade everything they source.';

insert into public.applied_migrations (version) values ('00770') on conflict do nothing;
