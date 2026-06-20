-- US-937: Conversion attribution & goal tracking — first/last-touch + ROI fields.
--
-- The trial-conversion drip already records ONE drip_attributions row per
-- converted enrollment (00253). This adds the columns that let a conversion be
-- attributed to the drip step/email that drove it and that power the ROI rollup
-- (US-946):
--
--   • attribution_model — last_touch | first_touch | organic. A converter who
--     never opened/clicked a drip email is 'organic' (AC4); otherwise the
--     conversion is credited to the last email they engaged with (last-touch).
--   • first_touch_step / last_touch_step — the first & last drip steps the user
--     engaged with before converting (NULL for organic). `step` (00253) stays the
--     canonical attributed step (= last_touch_step) so the US-946 funnel's
--     per-step conversion count is unchanged.
--   • last_touch_at — when the last-touch email was engaged.
--   • days_to_convert — trial-clock days from enrollment/trial-start to
--     conversion (denormalized alongside the RPC's live median for per-row ROI).
--
-- The webhook (customer.subscription.created) now fills mrr_cents +
-- stripe_subscription_id + stripe_reconciled from the live Stripe subscription,
-- so the existing rollup's attributed-MRR / reconciliation figures become real.
-- drip_attributions stays service-role only (written by the edge engine/webhook).

BEGIN;

alter table public.drip_attributions
  add column if not exists attribution_model text not null default 'last_touch',
  add column if not exists first_touch_step int,
  add column if not exists last_touch_step  int,
  add column if not exists last_touch_at    timestamptz,
  add column if not exists days_to_convert  numeric;

-- Constrain the model vocabulary (idempotent — skip if already present).
do $$ begin
  alter table public.drip_attributions
    add constraint drip_attributions_model_chk
    check (attribution_model in ('last_touch', 'first_touch', 'organic'));
exception
  when duplicate_object then null;
end $$;

comment on column public.drip_attributions.attribution_model is
  'US-937: last_touch | first_touch | organic (organic = converted without opening/clicking any drip email).';
comment on column public.drip_attributions.first_touch_step is
  'US-937: first drip step the converter engaged with before converting (NULL when organic).';
comment on column public.drip_attributions.last_touch_step is
  'US-937: last drip step the converter engaged with (= step, the canonical credit); NULL when organic.';
comment on column public.drip_attributions.days_to_convert is
  'US-937: trial-clock days from enrollment/trial-start to conversion (denormalized for ROI rows).';

COMMIT;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00273')
ON CONFLICT (version) DO NOTHING;
